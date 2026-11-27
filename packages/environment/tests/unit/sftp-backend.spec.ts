import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import ssh2 from 'ssh2'
import type { Attributes, FileEntry, SFTPWrapper } from 'ssh2'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { BackendContext, BackendSettings, EnvironmentBackend } from '../../src/backends/backend.js'
import { sftp } from '../../src/backends/sftp.js'
import { expectCompleteProgress, progressContent, progressRecorder } from './progress-fixtures.js'

const { Server, utils } = ssh2
const { STATUS_CODE } = utils.sftp
const USER = 'dev'
const PASSWORD = 'secret-password'

let root: string
let server: InstanceType<typeof Server>
let port: number
let backend: EnvironmentBackend
let local: string

/**
 * Describes a local file the way an SFTP server does.
 * @param stats - The local file information.
 * @returns The SFTP attributes.
 */
function attributesOf (stats: import('node:fs').Stats): Attributes {
  return { mode: stats.mode, uid: stats.uid, gid: stats.gid, size: stats.size, atime: Math.floor(stats.atimeMs / 1000), mtime: Math.floor(stats.mtimeMs / 1000) }
}

/**
 * Serves a temporary folder over SFTP, the paths of the client being the real paths of this machine.
 * @param channel - The SFTP channel of a session.
 */
function serveFiles (channel: SFTPWrapper): void {
  const handles = new Map<number, { file?: fs.FileHandle, entries?: FileEntry[] }>()
  let next = 0
  const handleOf = (value: { file?: fs.FileHandle, entries?: FileEntry[] }): Buffer => {
    const id = next++
    handles.set(id, value)
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32BE(id)
    return buffer
  }
  const fail = (reqid: number, error: unknown): void => {
    channel.status(reqid, (error as NodeJS.ErrnoException).code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE)
  }
  const stat = (reqid: number, target: string): void => {
    fs.stat(target).then(stats => channel.attrs(reqid, attributesOf(stats)), (error: unknown) => fail(reqid, error))
  }

  channel.on('REALPATH', (reqid, target) => {
    const resolved = path.resolve(root, target)
    channel.name(reqid, [{ filename: resolved, longname: resolved, attrs: {} as Attributes }])
  })
  channel.on('STAT', stat)
  channel.on('LSTAT', stat)
  channel.on('FSTAT', (reqid, handle) => {
    const file = handles.get(handle.readUInt32BE(0))?.file
    file?.stat().then(stats => channel.attrs(reqid, attributesOf(stats)), (error: unknown) => fail(reqid, error))
  })
  channel.on('OPEN', (reqid, filename, flags) => {
    const mode = utils.sftp.flagsToString(flags) ?? 'r'
    fs.open(filename, mode).then(file => channel.handle(reqid, handleOf({ file })), (error: unknown) => fail(reqid, error))
  })
  channel.on('READ', (reqid, handle, offset, length) => {
    const file = handles.get(handle.readUInt32BE(0))?.file
    const buffer = Buffer.alloc(length)
    file?.read(buffer, 0, length, offset).then(({ bytesRead }) => {
      if (bytesRead === 0) {
        channel.status(reqid, STATUS_CODE.EOF)
      } else {
        channel.data(reqid, buffer.subarray(0, bytesRead))
      }
    }, (error: unknown) => fail(reqid, error))
  })
  channel.on('WRITE', (reqid, handle, offset, data) => {
    const file = handles.get(handle.readUInt32BE(0))?.file
    file?.write(data, 0, data.length, offset).then(() => channel.status(reqid, STATUS_CODE.OK), (error: unknown) => fail(reqid, error))
  })
  channel.on('CLOSE', (reqid, handle) => {
    const id = handle.readUInt32BE(0)
    const entry = handles.get(id)
    handles.delete(id)
    Promise.resolve(entry?.file?.close()).then(() => channel.status(reqid, STATUS_CODE.OK), (error: unknown) => fail(reqid, error))
  })
  channel.on('OPENDIR', (reqid, target) => {
    fs.readdir(target, { withFileTypes: true }).then(async dirents => {
      const entries = await Promise.all(dirents.map(async dirent => {
        const stats = await fs.stat(path.join(target, dirent.name))
        const longname = `${dirent.isDirectory() ? 'd' : '-'}rw-r--r-- 1 dev dev ${stats.size} Jan 1 00:00 ${dirent.name}`
        return { filename: dirent.name, longname, attrs: attributesOf(stats) }
      }))
      channel.handle(reqid, handleOf({ entries }))
    }, (error: unknown) => fail(reqid, error))
  })
  channel.on('READDIR', (reqid, handle) => {
    const entry = handles.get(handle.readUInt32BE(0))
    if (entry?.entries?.length) {
      channel.name(reqid, entry.entries)
      entry.entries = []
    } else {
      channel.status(reqid, STATUS_CODE.EOF)
    }
  })
  channel.on('MKDIR', (reqid, target) => {
    fs.mkdir(target).then(() => channel.status(reqid, STATUS_CODE.OK), (error: unknown) => fail(reqid, error))
  })
  channel.on('REMOVE', (reqid, target) => {
    fs.unlink(target).then(() => channel.status(reqid, STATUS_CODE.OK), (error: unknown) => fail(reqid, error))
  })
  channel.on('RENAME', (reqid, from, to) => {
    fs.access(to).then(() => channel.status(reqid, STATUS_CODE.FAILURE), () => {
      fs.rename(from, to).then(() => channel.status(reqid, STATUS_CODE.OK), (error: unknown) => fail(reqid, error))
    })
  })
  channel.on('SETSTAT', reqid => channel.status(reqid, STATUS_CODE.OK))
  channel.on('FSETSTAT', reqid => channel.status(reqid, STATUS_CODE.OK))
}

/**
 * Reads a whole stream.
 * @param stream - The stream.
 * @returns Its content as text.
 */
async function textOf (stream: Readable | null): Promise<string | null> {
  if (stream === null) {
    return null
  }
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Writes a local file to upload.
 * @param name - The name of the file.
 * @param content - Its content.
 * @returns Its path.
 */
async function localFile (name: string, content: string): Promise<string> {
  const file = path.join(local, name)
  await fs.writeFile(file, content)
  return file
}

beforeAll(async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })
  server = new Server({ hostKeys: [privateKey] }, client => {
    client.on('authentication', context => {
      if (context.method === 'password' && context.username === USER && context.password === PASSWORD) {
        context.accept()
      } else {
        context.reject(['password'])
      }
    })
    client.on('ready', () => {
      client.on('session', accept => {
        accept().on('sftp', acceptSftp => {
          serveFiles(acceptSftp())
        })
      })
    })
    client.on('error', () => undefined)
  })
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>(resolve => {
    server.close(() => resolve())
  })
})

beforeEach(async () => {
  await backend?.close()
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-sftp-')))
  root = path.join(base, 'remote', 'environment')
  local = path.join(base, 'local')
  await fs.mkdir(local, { recursive: true })
  const shared: BackendSettings = { type: 'sftp', slug: 'nas', default: true, encryption: null, groups: { pull: null, push: null } }
  const { options, problems } = sftp.readOptions({ host: '127.0.0.1', port, username: USER, path: root, password: '{{ op://dev/nas/password }}' }, shared, 'environment.backends.nas')
  expect(problems).toEqual([])
  const context: BackendContext = {
    resolve: async text => text.replace('{{ op://dev/nas/password }}', PASSWORD),
    askSecret: async () => '',
    cacheDir: base,
    configFolder: base,
    auth: null
  }
  backend = sftp.create(options!, context)
})

describe('sftp backend', { timeout: 30_000 }, () => {
  it('lists nothing before the folder exists, then stores, lists, reads and deletes files', async () => {
    expect(await backend.list()).toEqual([])
    await backend.upload('api/config.yml', await localFile('config.yml', 'port: 3000\n'), 'application/yaml')
    await backend.upload('devtool/nested/db.gz', await localFile('db.gz', 'archive'), 'application/gzip')

    const files = await backend.list()
    expect(files?.map(file => file.path).sort()).toEqual(['api/config.yml', 'devtool/nested/db.gz'])
    const config = files!.find(file => file.path === 'api/config.yml')!
    expect(config.size).toBe(11)
    expect(config.version).toBe(`${config.updatedAt.getTime()}-11`)
    expect(await textOf(await backend.download('api/config.yml'))).toBe('port: 3000\n')

    await backend.remove('api/config.yml')
    await backend.remove('api/config.yml')
    expect(await backend.download('api/config.yml')).toBeNull()
    expect((await backend.list())?.map(file => file.path)).toEqual(['devtool/nested/db.gz'])
    await backend.close()
  })

  it('replaces a stored file and changes its version', async () => {
    await backend.upload('api/config.yml', await localFile('first.yml', 'port: 3000\n'), 'application/yaml')
    const before = (await backend.list())![0]
    await backend.upload('api/config.yml', await localFile('second.yml', 'port: 4000\nhost: api\n'), 'application/yaml')
    const after = (await backend.list())![0]
    expect(after.version).not.toBe(before.version)
    expect(await textOf(await backend.download('api/config.yml'))).toBe('port: 4000\nhost: api\n')
    expect(await fs.readdir(path.join(root, 'api'))).toEqual(['config.yml'])
    await backend.close()
  })

  it('reports the bytes it sends and receives, against the size of the file', async () => {
    const content = progressContent()
    const file = path.join(local, 'db.gz')
    await fs.writeFile(file, content)

    const sent = progressRecorder()
    await backend.upload('api/db.gz', file, 'application/gzip', { onProgress: sent.onProgress })
    expect((await fs.readFile(path.join(root, 'api/db.gz'))).equals(content)).toBe(true)
    expectCompleteProgress(sent.reports, content.length)

    const received = progressRecorder()
    const chunks: Buffer[] = []
    for await (const chunk of await backend.download('api/db.gz', { onProgress: received.onProgress }) ?? []) {
      chunks.push(chunk as Buffer)
    }
    expect(Buffer.concat(chunks).equals(content)).toBe(true)
    expectCompleteProgress(received.reports, content.length)
    await backend.close()
  })

  it('gives null for a missing file and leaves unfinished uploads out of the list', async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'cut.gz.part'), 'partial')
    expect(await backend.download('missing.yml')).toBeNull()
    expect(await backend.list()).toEqual([])
    await backend.close()
  })

  it('opens the connection again after it was closed', async () => {
    await backend.upload('a.txt', await localFile('a.txt', 'a'), 'text/plain')
    await backend.close()
    expect((await backend.list())?.map(file => file.path)).toEqual(['a.txt'])
    await backend.close()
  })
})
