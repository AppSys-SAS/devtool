import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArchiveWriter, type RecordHeader } from '../../src/archive.js'
import { IgnoredKeys } from '../../src/config-merge.js'
import type { BackendContext, EnvironmentBackend, RemoteFile } from '../../src/backends/backend.js'
import { Environment, type EnvironmentItem, TransferCancelledError } from '../../src/environment.js'
import { readSyncJournal, type SyncRecord, writeSyncRecord } from '../../src/sync-journal.js'

const UPDATED_AT = new Date('2026-01-01T00:00:00Z')
const ITEM_PATH = 'api/db.dump'
const PREVIOUS_RECORD: SyncRecord = { localUpdatedAt: new Date('2025-06-01T00:00:00Z'), remoteUpdatedAt: new Date('2025-06-01T00:00:00Z'), backend: 'team', remoteVersion: 'v1' }
const open = { backend: 'team', encryption: null, groups: { pull: null, push: null } }
const postgresItem: EnvironmentItem = { kind: 'database', path: ITEM_PATH, ...open, engine: 'postgres', container: 'db', database: null, format: 'native' }
const mariadbItem: EnvironmentItem = { ...postgresItem, engine: 'mariadb' }

let folder: string
let downloads: number
let downloadGate: Promise<void>

/**
 * Builds an environment of one item whose backend stores one archive, downloaded once
 * `downloadGate` resolves, each transfer of bytes reported whole at once.
 * @param item - The item.
 * @param archive - The archive the backend stores, or the stream it gives.
 * @param listing - Lists the files of the backend.
 * @param cacheDir - The cache folder of the environment.
 * @returns The environment.
 */
function environmentOf (item: EnvironmentItem, archive: Buffer | Readable, listing?: () => Promise<RemoteFile[] | null>, cacheDir = folder): Environment {
  const size = Buffer.isBuffer(archive) ? archive.length : 0
  const backend: EnvironmentBackend = {
    list: listing ?? (async () => [{ path: item.path, size, updatedAt: UPDATED_AT, version: 'v2' }]),
    download: async (_path, { onProgress } = {}) => {
      downloads += 1
      await downloadGate
      onProgress?.(size, size)
      return Buffer.isBuffer(archive) ? Readable.from([archive]) : archive
    },
    upload: async (_path, localFile, _mediaType, { onProgress } = {}) => {
      const { size } = await fs.stat(localFile)
      onProgress?.(size, size)
    },
    remove: async () => undefined,
    close: async () => undefined
  }
  const context: BackendContext = { resolve: async text => text, askSecret: async () => '', cacheDir, configFolder: folder, auth: null }
  const options = { folder: path.join(folder, 'env'), backends: [], defaultBackend: 'team', items: [item], configFiles: [], autoPulls: [], sections: { by: 'folder' as const, names: new Map<string, string>() }, s3: null }
  return new Environment(new Map([['team', backend]]), options, context)
}

/**
 * Builds an environment of some items on one backend.
 * @param backend - The backend.
 * @param items - The items.
 * @returns The environment.
 */
function environmentWith (backend: Partial<EnvironmentBackend>, items: EnvironmentItem[] = [postgresItem]): Environment {
  const whole: EnvironmentBackend = {
    list: async () => [],
    download: async () => null,
    upload: async () => undefined,
    remove: async () => undefined,
    close: async () => undefined,
    ...backend
  }
  const context: BackendContext = { resolve: async text => text, askSecret: async () => '', cacheDir: folder, configFolder: folder, auth: null }
  const options = { folder: path.join(folder, 'env'), backends: [], defaultBackend: 'team', items, configFiles: [], autoPulls: [], sections: { by: 'folder' as const, names: new Map<string, string>() }, s3: null }
  return new Environment(new Map([['team', whole]]), options, context)
}

/**
 * Lets the pending work of the event loop run until a condition holds, timers being faked.
 * @param condition - The condition.
 */
async function settle (condition: () => boolean): Promise<void> {
  while (!condition()) {
    await new Promise(resolve => {
      setImmediate(resolve)
    })
  }
}

/**
 * Replaces the docker command by a shell script reading its standard input first.
 * @param body - What the script does once its input is read.
 */
async function fakeDocker (body: string): Promise<void> {
  await fs.writeFile(path.join(folder, 'bin', 'docker'), `#!/bin/sh\ncat > /dev/null\n${body}\n`, { mode: 0o755 })
}

/**
 * Reads what a pull left in the folder of the item: the names of its files and the content of its
 * local copy.
 * @returns The files and the local copy.
 */
async function localState (): Promise<{ files: string[], copy: string }> {
  const itemFolder = path.join(folder, 'env', 'api')
  return { files: await fs.readdir(itemFolder), copy: await fs.readFile(path.join(itemFolder, 'db.dump'), 'utf-8') }
}

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-pull-'))
  downloads = 0
  downloadGate = Promise.resolve()
  await fs.mkdir(path.join(folder, 'env', 'api'), { recursive: true })
  await fs.mkdir(path.join(folder, 'bin'))
  await fs.writeFile(path.join(folder, 'env', 'api', 'db.dump'), 'previous copy')
  await fakeDocker(`cat "${path.join(folder, 'env', 'api', 'db.dump')}" > "${path.join(folder, 'seen')}"`)
  vi.stubEnv('PATH', `${path.join(folder, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`)
  vi.stubEnv('ADT_CONFIG_FOLDER', folder)
  await writeSyncRecord(ITEM_PATH, PREVIOUS_RECORD)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fs.rm(folder, { recursive: true, force: true })
})

describe('pull of an item holding local data', () => {
  it('reads a whole devtool archive before touching the database, so a truncated one changes nothing', async () => {
    const item: EnvironmentItem = { ...postgresItem, format: 'devtool' }
    const archivePath = path.join(folder, 'whole.gz')
    const writer = new ArchiveWriter(archivePath)
    await writer.add({ type: 'database', engine: 'postgres' })
    await writer.add({ type: 'schema' }, Readable.from([Buffer.from('CREATE TABLE t (id int);\n')]))
    await writer.add({ type: 'table', name: 'public.t' }, Readable.from([Buffer.from('x'.repeat(100_000))]))
    await writer.close()
    const whole = await fs.readFile(archivePath)

    await expect(environmentOf(item, whole.subarray(0, Math.floor(whole.length / 2))).pull({ item, tables: null })).rejects.toThrow()
    await expect(fs.access(path.join(folder, 'seen'))).rejects.toThrow()
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
  })

  it.each<[string, RecordHeader[]]>([
    ['a key record without a numeric time to live', [{ type: 'redis' }, { type: 'key', key: Buffer.from('session:a').toString('base64'), ttl: 'soon' }]],
    ['a key record with a negative time to live', [{ type: 'redis' }, { type: 'key', key: Buffer.from('session:a').toString('base64'), ttl: -1 }]],
    ['a second Redis header', [{ type: 'redis' }, { type: 'key', key: Buffer.from('session:a').toString('base64'), ttl: 0 }, { type: 'redis' }]]
  ])('refuses a Redis archive holding %s before reaching the database', async (_case, headers) => {
    const item: EnvironmentItem = { kind: 'redis', path: ITEM_PATH, ...open, url: 'redis://127.0.0.1:1/0' }
    const archivePath = path.join(folder, 'redis.gz')
    const writer = new ArchiveWriter(archivePath)
    for (const header of headers) {
      await writer.add(header, header.type === 'key' ? Readable.from([Buffer.from('x')]) : undefined)
    }
    await writer.close()

    await expect(environmentOf(item, await fs.readFile(archivePath)).pull({ item, tables: null })).rejects.toThrow('not a Redis snapshot')
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
    expect((await readSyncJournal()).get(ITEM_PATH)).toEqual(PREVIOUS_RECORD)
  })

  it('replaces the local copy and records the synchronization only once the data is restored', async () => {
    expect(await environmentOf(postgresItem, Buffer.from('new archive')).pull({ item: postgresItem, tables: null })).toEqual({ done: true, detail: 'database restored in db' })

    expect(await fs.readFile(path.join(folder, 'seen'), 'utf-8')).toBe('previous copy')
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'new archive' })
    expect((await readSyncJournal()).get(ITEM_PATH)).toMatchObject({ remoteUpdatedAt: UPDATED_AT, backend: 'team', remoteVersion: 'v2' })
  })

  it('leaves the local copy and the synchronization record as they were when the container refuses the archive', async () => {
    await fakeDocker('echo "pg_restore: error: input file does not appear to be a valid archive" >&2; exit 1')
    await expect(environmentOf(postgresItem, Buffer.from('new archive')).pull({ item: postgresItem, tables: null })).rejects.toThrow('does not appear to be a valid archive')

    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
    expect((await readSyncJournal()).get(ITEM_PATH)).toEqual(PREVIOUS_RECORD)
  })

  it.each<[string, EnvironmentItem, Buffer, string]>([
    ['a native database archive refused before the container', mariadbItem, gzipSync('-- dump\nUSE `shop`;\n'), 'the dump names its own database'],
    ['a truncated native bucket archive', { kind: 'bucket', path: ITEM_PATH, ...open, bucket: 'uploads', format: 'native' }, gzipSync(Buffer.alloc(700)), 'is not a complete tar.gz archive'],
    ['a file that is not a Redis archive', { kind: 'redis', path: ITEM_PATH, ...open, url: 'redis://127.0.0.1:1/0' }, Buffer.from('not an archive'), '']
  ])('leaves the local copy and the synchronization record as they were for %s', async (_case, item, archive, message) => {
    await expect(environmentOf(item, archive).pull({ item, tables: null })).rejects.toThrow(message)

    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
    expect((await readSyncJournal()).get(ITEM_PATH)).toEqual(PREVIOUS_RECORD)
  })

  it('reports a restore whose synchronization cannot be recorded, the local copy replaced', async () => {
    const listings = [true, false]
    const listing = async (): Promise<RemoteFile[]> => {
      if (listings.shift() ?? false) {
        return [{ path: ITEM_PATH, size: 11, updatedAt: UPDATED_AT, version: 'v2' }]
      }
      throw new Error('backend unreachable')
    }
    const result = await environmentOf(postgresItem, Buffer.from('new archive'), listing).pull({ item: postgresItem, tables: null })

    expect(result).toEqual({ done: true, detail: 'database restored in db, not recorded as synchronized: backend unreachable' })
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'new archive' })
    expect((await readSyncJournal()).get(ITEM_PATH)).toEqual(PREVIOUS_RECORD)
  })

  it.each<[string, () => Promise<RemoteFile[]>, string]>([
    ['failed', async () => Promise.reject(new Error('backend unreachable')), ' (backend unreachable)'],
    ['did not hold the item', async () => [], '']
  ])('does not record as synchronized a pull whose listing before the download %s, whatever the listing after, telling why', async (_case, before, reason) => {
    const listings = [before, async (): Promise<RemoteFile[]> => [{ path: ITEM_PATH, size: 11, updatedAt: UPDATED_AT, version: 'v3' }]]
    const listing = async (): Promise<RemoteFile[]> => (listings.length > 1 ? listings.shift()! : listings[0])()
    const result = await environmentOf(postgresItem, Buffer.from('new archive'), listing).pull({ item: postgresItem, tables: null })

    expect(result).toEqual({ done: true, detail: `database restored in db, not recorded as synchronized: the copy of team could not be listed before the pull${reason}: pull again` })
    expect((await readSyncJournal()).get(ITEM_PATH)).toEqual(PREVIOUS_RECORD)
  })

  it('pulls without recording from a backend that lists nothing', async () => {
    const result = await environmentOf(postgresItem, Buffer.from('new archive'), async () => null).pull({ item: postgresItem, tables: null })

    expect(result).toEqual({ done: true, detail: 'database restored in db' })
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'new archive' })
    expect((await readSyncJournal()).get(ITEM_PATH)).toEqual(PREVIOUS_RECORD)
  })

  it('does not record as synchronized a copy of the backend that changed during the pull', async () => {
    const versions = ['v2', 'v3']
    const listing = async (): Promise<RemoteFile[]> => [{ path: ITEM_PATH, size: 11, updatedAt: UPDATED_AT, version: versions.shift() ?? 'v3' }]
    const result = await environmentOf(postgresItem, Buffer.from('new archive'), listing).pull({ item: postgresItem, tables: null })

    expect(result).toEqual({ done: true, detail: 'database restored in db, not recorded as synchronized: the copy of team changed during the pull: pull again' })
    expect((await readSyncJournal()).get(ITEM_PATH)).toEqual(PREVIOUS_RECORD)
  })

  it('reports what the restore could not clean up once the database was restored', async () => {
    await fakeDocker('echo "its former copy adt_replaced_0123 could not be dropped: drop it by hand"')
    const result = await environmentOf(postgresItem, Buffer.from('new archive')).pull({ item: postgresItem, tables: null })

    expect(result).toEqual({ done: true, detail: 'database restored in db, but its former copy adt_replaced_0123 could not be dropped: drop it by hand' })
    expect((await readSyncJournal()).get(ITEM_PATH)).toMatchObject({ remoteVersion: 'v2' })
  })

  it('refuses a pull and a push while another process transfers the item, changing nothing', async () => {
    const environment = environmentOf(postgresItem, Buffer.from('new archive'))
    const key = createHash('sha256').update(ITEM_PATH).digest('hex')
    await fs.mkdir(path.join(folder, 'env', '.devtool-locks'))
    await fs.writeFile(path.join(folder, 'env', '.devtool-locks', `${key}.lock`), String(process.ppid))

    await expect(environment.pull({ item: postgresItem, tables: null })).rejects.toThrow(`api/db.dump is in use by another process (${process.ppid})`)
    await expect(environment.push({ item: postgresItem, tables: null })).rejects.toThrow('api/db.dump is in use by another process')
    expect(downloads).toBe(0)
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
  })

  it('refuses a transfer of an item another environment of the same folder runs, whatever their cache folders and spellings of its path', async () => {
    let open = (): void => undefined
    downloadGate = new Promise(resolve => {
      open = resolve
    })
    const first = environmentOf(postgresItem, Buffer.from('new archive'), undefined, path.join(folder, 'cache-a')).pull({ item: postgresItem, tables: null })
    await vi.waitFor(() => {
      expect(downloads).toBe(1)
    })

    const second = environmentOf(postgresItem, Buffer.from('new archive'), undefined, path.join(folder, 'cache-b'))
    await expect(second.pull({ item: postgresItem, tables: null })).rejects.toThrow('api/db.dump is in use: try again once it ends')
    const spelled: EnvironmentItem = { ...postgresItem, path: 'API/db.dump' }
    await expect(environmentOf(spelled, Buffer.from('new archive')).pull({ item: spelled, tables: null })).rejects.toThrow('API/db.dump is in use: try again once it ends')
    open()
    expect(await first).toEqual({ done: true, detail: 'database restored in db' })
  })

  it('refuses some tables of an archive restoring the whole database only, before downloading it', async () => {
    await expect(environmentOf(mariadbItem, gzipSync('-- dump\n')).pull({ item: mariadbItem, tables: ['users'] })).rejects.toThrow('api/db.dump is a native mariadb archive: pull the whole database')

    expect(downloads).toBe(0)
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
  })
})

describe('watch of a backend', () => {
  const notes: EnvironmentItem = { kind: 'file', path: 'api/notes.txt', ...open, ignore: null }

  beforeEach(async () => {
    await fs.writeFile(path.join(folder, 'env', 'api', 'notes.txt'), 'local notes')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops a download whose backend stops sending, leaving the local copy as it was', async () => {
    let opened = false
    const pull = environmentWith({
      download: async (_path, { onProgress } = {}) => {
        opened = true
        onProgress?.(10, 100)
        return new PassThrough()
      }
    }).pull({ item: postgresItem, tables: null })
    const failure = expect(pull).rejects.toThrow('the backend showed no activity for 60 s')
    await settle(() => opened)
    await vi.advanceTimersByTimeAsync(60_000)

    await failure
    expect(await localState()).toEqual({ files: ['db.dump', 'notes.txt'], copy: 'previous copy' })
  })

  it('never stops a download that keeps sending, however long it takes', async () => {
    const chunks = 10
    let opened = false
    const pull = environmentWith({
      list: async () => [{ path: notes.path, size: chunks, updatedAt: UPDATED_AT, version: 'v2' }],
      download: async (_path, { onProgress } = {}) => {
        opened = true
        const body = new PassThrough()
        let sent = 0
        /**
         * Sends one more byte, well within the tolerated silence.
         */
        const next = (): void => {
          sent += 1
          body.write('x')
          onProgress?.(sent, chunks)
          if (sent === chunks) {
            body.end()
          } else {
            setTimeout(next, 50_000)
          }
        }
        setTimeout(next, 50_000)
        return body
      }
    }, [notes]).pull({ item: notes, tables: null })
    await settle(() => opened)
    await vi.advanceTimersByTimeAsync(chunks * 50_000)

    expect(await pull).toMatchObject({ done: true })
    expect(await fs.readFile(path.join(folder, 'env', 'api', 'notes.txt'), 'utf-8')).toBe('x'.repeat(chunks))
  })

  it('never times a backend that bounds its exchanges itself', async () => {
    let opened = false
    const pull = environmentWith({
      boundsItself: true,
      list: async () => [{ path: notes.path, size: 12, updatedAt: UPDATED_AT, version: 'v2' }],
      download: async () => {
        opened = true
        await new Promise(resolve => {
          setTimeout(resolve, 180_000)
        })
        return Readable.from([Buffer.from('pulled notes')])
      }
    }, [notes]).pull({ item: notes, tables: null })
    await settle(() => opened)
    await vi.advanceTimersByTimeAsync(180_000)

    expect(await pull).toMatchObject({ done: true })
    expect(await fs.readFile(path.join(folder, 'env', 'api', 'notes.txt'), 'utf-8')).toBe('pulled notes')
  })

  it('never stops a silent upload, nor one that sent its whole file and waits for its backend', async () => {
    let waiting = false
    /**
     * Waits two minutes, as a backend storing a file does.
     */
    const store = async (): Promise<void> => {
      await new Promise(resolve => {
        waiting = true
        setTimeout(resolve, 120_000)
      })
    }
    const silent = environmentWith({ upload: store }, [notes]).push({ item: notes, tables: null })
    await settle(() => waiting)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await silent).toMatchObject({ done: true })

    waiting = false
    const sent = environmentWith({
      upload: async (_path, localFile, _mediaType, { onProgress } = {}) => {
        const { size } = await fs.stat(localFile)
        onProgress?.(size, size)
        await store()
      }
    }, [notes]).push({ item: notes, tables: null })
    await settle(() => waiting)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await sent).toMatchObject({ done: true })
  })

  it('stops an upload whose backend stops telling its progress before the end of the file', async () => {
    let started = false
    const push = environmentWith({
      upload: async (_path, _localFile, _mediaType, { onProgress, signal } = {}) => {
        started = true
        onProgress?.(1, 100)
        await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new Error('upload stopped'))
          })
        })
      }
    }, [notes]).push({ item: notes, tables: null })
    const failure = expect(push).rejects.toThrow('the backend showed no activity for 60 s')
    await settle(() => started)
    await vi.advanceTimersByTimeAsync(60_000)

    await failure
  })

  it('does not count the time the developer takes to give what the backend needs', async () => {
    let asking = false
    let given: Promise<void> | null = null
    const pull = environmentWith({
      prepare: async () => {
        given ??= new Promise(resolve => {
          asking = true
          setTimeout(resolve, 90_000)
        })
        return given
      },
      list: async () => [{ path: notes.path, size: 12, updatedAt: UPDATED_AT, version: 'v2' }],
      download: async () => Readable.from([Buffer.from('pulled notes')])
    }, [notes]).pull({ item: notes, tables: null })
    await settle(() => asking)
    await vi.advanceTimersByTimeAsync(90_000)

    expect(await pull).toMatchObject({ done: true })
    expect(await fs.readFile(path.join(folder, 'env', 'api', 'notes.txt'), 'utf-8')).toBe('pulled notes')
  })

  it('gives up a transfer whose backend never gets what it needs from the developer, after a few minutes', async () => {
    let asking = false
    const pull = environmentWith({
      prepare: async () => new Promise(() => {
        asking = true
      })
    }, [notes]).pull({ item: notes, tables: null })
    const failure = pull.catch((error: unknown) => error)
    await settle(() => asking)
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(await failure).toMatchObject({ message: expect.stringContaining('did not get what it needs from the developer within 5 minutes') as unknown })
    expect(await fs.readFile(path.join(folder, 'env', 'api', 'notes.txt'), 'utf-8')).toBe('local notes')
  })

  it('does not count the time the developer takes to approve what a listing needs', async () => {
    let approval: Promise<void> | null = null
    let asking = false
    /**
     * Waits for the developer to approve the reading of a secret, once.
     * @returns Once approved.
     */
    const approve = async (): Promise<void> => {
      approval ??= new Promise(resolve => {
        asking = true
        setTimeout(resolve, 90_000)
      })
      return approval
    }
    const described = environmentWith({
      prepare: approve,
      list: async () => {
        await approve()
        return [{ path: notes.path, size: 12, updatedAt: UPDATED_AT, version: 'v2' }]
      }
    }, [notes]).describe()
    await settle(() => asking)
    await vi.advanceTimersByTimeAsync(90_000)

    const { items: [item], errors } = await described
    expect(errors).toEqual({})
    expect(item.remote).toMatchObject({ version: 'v2' })
  })
})

describe('cancel and end of a push', () => {
  it('leaves both copies as they were when cancelled while its dump uploads', async () => {
    await fakeDocker('printf "fresh dump"')
    let uploading = false
    let stored = false
    const cancel = new AbortController()
    const push = environmentWith({
      upload: async (_path, _localFile, _mediaType, { signal } = {}) => {
        uploading = true
        await new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new Error('upload stopped'))
          })
        })
        stored = true
      }
    }).push({ item: postgresItem, tables: null, signal: cancel.signal })
    await vi.waitFor(() => expect(uploading).toBe(true))
    cancel.abort(new Error('cancelled'))

    await expect(push).rejects.toBeInstanceOf(TransferCancelledError)
    expect(stored).toBe(false)
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
  })

  it('tells a push whose dump is stored as done, though its synchronization cannot be recorded', async () => {
    await fakeDocker('printf "fresh dump"')
    const result = await environmentWith({
      list: async () => {
        throw new Error('listing refused')
      }
    }).push({ item: postgresItem, tables: null })

    expect(result).toEqual({ done: true, detail: 'database dumped from db, not recorded as synchronized: listing refused' })
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'fresh dump' })
  })
})

describe('leftovers of an interrupted transfer', () => {
  it('removes the temporary files of the item before transferring it, never another file named after it', async () => {
    const other: EnvironmentItem = { kind: 'file', path: 'api/db.dump.merged', ...open, ignore: null }
    const api = path.join(folder, 'env', 'api')
    await fs.writeFile(path.join(api, `db.dump.${randomUUID()}.pull`), 'half an archive')
    await fs.writeFile(path.join(api, `db.dump.${randomUUID()}.push.${randomUUID()}.sealed`), 'half a sealed dump')
    await fs.writeFile(path.join(api, `db.dump.${randomUUID()}.part`), 'half a copy')
    await fs.writeFile(path.join(api, 'db.dump.merged'), 'another item')
    await fs.writeFile(path.join(api, 'db.dump.part'), 'a file of the developer')
    await fs.writeFile(path.join(api, 'db.dump.base'), 'another file of the developer')

    expect(await environmentWith({}, [postgresItem, other]).restoreLocal({ item: postgresItem, tables: null })).toMatchObject({ done: true })
    expect((await fs.readdir(api)).sort()).toEqual(['db.dump', 'db.dump.base', 'db.dump.merged', 'db.dump.part'])
  })

  it('never writes a transfer of an item over another item named after it', async () => {
    const config: EnvironmentItem = { kind: 'file', path: 'api/app.yml', ...open, ignore: null }
    const neighbour: EnvironmentItem = { kind: 'file', path: 'api/app.yml.part', ...open, ignore: null }
    const api = path.join(folder, 'env', 'api')
    await fs.writeFile(path.join(api, 'app.yml.part'), 'the other item')

    const environment = environmentWith({
      list: async () => [{ path: 'api/app.yml', size: 10, updatedAt: UPDATED_AT, version: 'v2' }],
      download: async () => Readable.from([Buffer.from('port: 3000')])
    }, [config, neighbour])
    expect(await environment.pull({ item: config, tables: null })).toMatchObject({ done: true })
    expect(await fs.readFile(path.join(api, 'app.yml'), 'utf-8')).toBe('port: 3000')
    expect(await fs.readFile(path.join(api, 'app.yml.part'), 'utf-8')).toBe('the other item')
  })
})

describe('description of the items', () => {
  it('describes the local copies when a backend does not answer, telling it after a minute', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const described = environmentOf(postgresItem, Buffer.alloc(0), async () => new Promise(() => {})).describe()
      await vi.advanceTimersByTimeAsync(60_000)
      const { items: [item], errors } = await described

      expect(errors).toEqual({ team: 'the backend showed no activity for 60 s' })
      expect(item.local).toMatchObject({ size: 'previous copy'.length })
      expect(item.remote).toBe('unknown')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('description of a configuration file ignoring keys', () => {
  it('describes it when its backend lists it but never gives its copy, after a minute', async () => {
    const item: EnvironmentItem = { kind: 'file', path: 'api/app.yml', ...open, ignore: new IgnoredKeys(['secret']) }
    await fs.writeFile(path.join(folder, 'env', 'api', 'app.yml'), 'port: 1\n')
    downloadGate = new Promise(() => {})
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const described = environmentOf(item, Buffer.from('port: 2\n')).describe()
      while (downloads < 1) {
        await new Promise(resolve => {
          setImmediate(resolve)
        })
      }
      await vi.advanceTimersByTimeAsync(60_000)

      const { items: [description] } = await described
      expect(description.remote).toMatchObject({ version: 'v2' })
      expect(await fs.readdir(path.join(folder, 'env', 'api'))).toEqual(['app.yml', 'db.dump'])
    } finally {
      vi.useRealTimers()
    }
  }, 10_000)
})

describe('push of an item holding local data', () => {
  it.each([
    ['writing', 'while true; do echo row; sleep 0.05; done'],
    ['waiting silently', 'sleep 6; echo late']
  ])('stops a dump %s that its push cancels, the backend never reached and the local copy left as it was', async (_case, dump) => {
    await fakeDocker(dump)
    const upload = vi.fn(async () => undefined)
    const environment = environmentWith({ upload })
    const cancel = new AbortController()
    setTimeout(() => cancel.abort(new Error('cancelled')), 500)
    const started = Date.now()

    await expect(environment.push({ item: postgresItem, tables: null, signal: cancel.signal })).rejects.toThrow(TransferCancelledError)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(upload).not.toHaveBeenCalled()
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
  }, 10_000)

  it('stops writing an archive once cancelled, leaving the body of the record unread', async () => {
    const cancel = new AbortController()
    const writer = new ArchiveWriter(path.join(folder, 'cancelled.gz'), cancel.signal)
    let closed = false
    const body = (async function* (): AsyncGenerator<Buffer> {
      try {
        for (let chunk = 0; ; chunk++) {
          if (chunk === 3) {
            cancel.abort(new Error('cancelled'))
          }
          yield Buffer.from('row\n')
        }
      } finally {
        closed = true
      }
    })()

    await expect(writer.add({ type: 'table', name: 'public.t' }, body)).rejects.toThrow('cancelled')
    writer.abort()
    expect(closed).toBe(true)
  })

  it('leaves the local copy as it was when the backend refuses the dump', async () => {
    await fakeDocker('printf "fresh dump"')
    const backend: EnvironmentBackend = {
      list: async () => [],
      download: async () => null,
      upload: async () => {
        throw new Error('storage full')
      },
      remove: async () => undefined,
      close: async () => undefined
    }
    const context: BackendContext = { resolve: async text => text, askSecret: async () => '', cacheDir: folder, configFolder: folder, auth: null }
    const options = { folder: path.join(folder, 'env'), backends: [], defaultBackend: 'team', items: [postgresItem], configFiles: [], autoPulls: [], sections: { by: 'folder' as const, names: new Map<string, string>() }, s3: null }

    await expect(new Environment(new Map([['team', backend]]), options, context).push({ item: postgresItem, tables: null })).rejects.toThrow('storage full')
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
  })

  it('keeps the stored values of the ignored keys of a configuration file when its backend cannot list its files', async () => {
    const item: EnvironmentItem = { kind: 'file', path: 'api/app.yml', ...open, ignore: new IgnoredKeys(['secret']) }
    await fs.writeFile(path.join(folder, 'env', 'api', 'app.yml'), 'port: 1\nsecret: local\n')
    const uploaded: string[] = []
    const environment = environmentWith({
      list: async () => Promise.reject(new Error('backend unreachable')),
      download: async () => Readable.from([Buffer.from('port: 2\nsecret: stored\n')]),
      upload: async (_path, localFile) => {
        uploaded.push(await fs.readFile(localFile, 'utf-8'))
      }
    }, [item])

    await environment.push({ item, tables: null })
    expect(uploaded).toEqual(['port: 1\nsecret: stored\n'])
  })

  it('lists the backend once for a pull of a configuration file whose listing fails, keeping its ignored keys', async () => {
    const item: EnvironmentItem = { kind: 'file', path: 'api/app.yml', ...open, ignore: new IgnoredKeys(['secret']) }
    const localPath = path.join(folder, 'env', 'api', 'app.yml')
    await fs.writeFile(localPath, 'port: 1\nsecret: local\n')
    const list = vi.fn(async () => Promise.reject(new Error('backend unreachable')))
    const environment = environmentWith({ list, download: async () => Readable.from([Buffer.from('port: 2\nsecret: stored\n')]) }, [item])

    await environment.pull({ item, tables: null })
    expect(list).toHaveBeenCalledOnce()
    expect(await fs.readFile(localPath, 'utf-8')).toBe('port: 2\nsecret: local\n')
  })
})

describe('synchronization journal', () => {
  it('never replaces a journal it cannot read', async () => {
    const journal = path.join(folder, 'sync.json')
    await fs.writeFile(journal, '{ "api/db.dump": ')

    await expect(writeSyncRecord('api/notes.txt', PREVIOUS_RECORD)).rejects.toThrow(`the synchronization journal ${journal} cannot be read`)
    expect(await fs.readFile(journal, 'utf-8')).toBe('{ "api/db.dump": ')
  })

  it('keeps every record written at the same time', async () => {
    const paths = Array.from({ length: 20 }, (_, index) => `api/file-${index}.txt`)
    await Promise.all(paths.map(async itemPath => writeSyncRecord(itemPath, PREVIOUS_RECORD)))

    const journal = await readSyncJournal()
    expect(paths.filter(itemPath => journal.has(itemPath))).toEqual(paths)
    expect((await fs.readdir(folder)).filter(name => name.endsWith('.part'))).toEqual([])
  })

  it('removes the partial journals a stopped process left', async () => {
    const leftover = path.join(folder, `sync.json.${randomUUID()}.part`)
    await fs.writeFile(leftover, '{}')

    await writeSyncRecord('api/notes.txt', PREVIOUS_RECORD)
    await expect(fs.access(leftover)).rejects.toThrow()
  })

  it('waits for another process writing the journal, keeping its record', async () => {
    const journal = path.join(folder, 'sync.json')
    const lock = `${journal}.lock`
    await fs.writeFile(lock, String(process.ppid))
    const seen = await fs.readFile(journal, 'utf-8')

    const writing = writeSyncRecord('api/mine.txt', PREVIOUS_RECORD)
    await new Promise(resolve => {
      setTimeout(resolve, 200)
    })
    const theirs = { ...JSON.parse(seen) as Record<string, unknown>, 'api/theirs.txt': JSON.parse(JSON.stringify(PREVIOUS_RECORD)) as unknown }
    await fs.writeFile(journal, JSON.stringify(theirs))
    await fs.rm(lock)
    await writing

    expect([...(await readSyncJournal()).keys()].sort()).toEqual(['api/db.dump', 'api/mine.txt', 'api/theirs.txt'])
  })
})

describe('listings after a transfer', () => {
  it('ends a pull whose backend no longer answers once the data is restored, not recording it as synchronized', async () => {
    let listings = 0
    /**
     * Lists the archive of the item, the backend never answering after the first listing.
     * @returns The files of the backend.
     */
    const listing = async (): Promise<RemoteFile[]> => {
      listings += 1
      return listings === 1 ? [{ path: ITEM_PATH, size: 11, updatedAt: UPDATED_AT, version: 'v2' }] : new Promise(() => {})
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pull = environmentOf(postgresItem, Buffer.from('new archive'), listing).pull({ item: postgresItem, tables: null })
      while (listings < 2) {
        await new Promise(resolve => {
          setImmediate(resolve)
        })
      }
      await vi.advanceTimersByTimeAsync(60_000)

      expect(await pull).toEqual({ done: true, detail: 'database restored in db, not recorded as synchronized: the backend showed no activity for 60 s' })
      expect((await readSyncJournal()).get(ITEM_PATH)).toEqual(PREVIOUS_RECORD)
    } finally {
      vi.useRealTimers()
    }
  }, 10_000)
})

describe('restore and removal of a local copy', () => {
  it('restores the local data from the local copy without reaching the backend', async () => {
    const listing = vi.fn(async () => [])
    expect(await environmentOf(postgresItem, Buffer.from('new archive'), listing).restoreLocal({ item: postgresItem, tables: null })).toEqual({ done: true, detail: 'database restored in db' })

    expect(listing).not.toHaveBeenCalled()
    expect(downloads).toBe(0)
    expect(await fs.readFile(path.join(folder, 'seen'), 'utf-8')).toBe('previous copy')
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
    expect((await readSyncJournal()).get(ITEM_PATH)).toEqual(PREVIOUS_RECORD)
  })

  it('refuses tables its archive lacks before changing the database', async () => {
    const item: EnvironmentItem = { ...postgresItem, format: 'devtool' }
    const writer = new ArchiveWriter(path.join(folder, 'env', 'api', 'db.dump'))
    await writer.add({ type: 'database', engine: 'postgres' })
    await writer.add({ type: 'table', name: 'public.t' }, Readable.from([Buffer.from('rows of t')]))
    await writer.close()
    const calls = path.join(folder, 'docker-calls')
    await fs.writeFile(path.join(folder, 'bin', 'docker'), `#!/bin/sh\nscript="$* $(cat)"\necho call >> "${calls}"\ncase "$script" in *pg_class*) printf 'public.t\\npublic.u\\n' ;; esac\n`, { mode: 0o755 })

    await expect(environmentOf(item, Buffer.alloc(0)).restoreLocal({ item, tables: ['public.t', 'public.u'] })).rejects.toThrow('unknown tables in api/db.dump: public.u')
    await expect(fs.access(calls)).rejects.toThrow()
  })

  it('reports an item without local copy, and refuses a file or tables of a native mariadb archive', async () => {
    const environment = environmentOf(postgresItem, Buffer.from('new archive'))
    await fs.rm(path.join(folder, 'env', 'api', 'db.dump'))
    expect(await environment.restoreLocal({ item: postgresItem, tables: null })).toEqual({ done: false, detail: 'no local copy, pull it first' })

    const file: EnvironmentItem = { kind: 'file', path: 'api/notes.txt', ...open, ignore: null }
    await expect(environment.restoreLocal({ item: file, tables: null })).rejects.toThrow('api/notes.txt is a file: its local copy is its data, pull it instead')
    await expect(environment.removeLocalCopy({ item: file, tables: null })).rejects.toThrow('api/notes.txt is a file: its local copy is its data, there is no copy to remove apart from it')
    await expect(environmentOf(mariadbItem, Buffer.alloc(0)).restoreLocal({ item: mariadbItem, tables: ['users'] })).rejects.toThrow('api/db.dump is a native mariadb archive: restore the whole database')
  })

  it('removes the local copy and keeps the synchronization record', async () => {
    const environment = environmentOf(postgresItem, Buffer.from('new archive'))
    expect(await environment.removeLocalCopy({ item: postgresItem, tables: null })).toMatchObject({ done: true })

    expect(await fs.readdir(path.join(folder, 'env', 'api'))).toEqual([])
    expect((await readSyncJournal()).get(ITEM_PATH)).toEqual(PREVIOUS_RECORD)
    expect(await environment.removeLocalCopy({ item: postgresItem, tables: null })).toMatchObject({ done: true })
    expect(downloads).toBe(0)
  })
})

describe('cancel of a pull', () => {
  it('leaves everything as it was when cancelled while the archive downloads, raising a cancel', async () => {
    let release = (): void => undefined
    downloadGate = new Promise(resolve => {
      release = resolve
    })
    const cancel = new AbortController()
    const pull = environmentOf(postgresItem, Buffer.from('new archive')).pull({ item: postgresItem, tables: null, signal: cancel.signal })
    await vi.waitFor(() => expect(downloads).toBe(1))
    cancel.abort(new Error('cancelled'))
    release()

    await expect(pull).rejects.toBeInstanceOf(TransferCancelledError)
    await expect(fs.access(path.join(folder, 'seen'))).rejects.toThrow()
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
    expect((await readSyncJournal()).get(ITEM_PATH)).toEqual(PREVIOUS_RECORD)
  })

  it('gives up a listing that does not answer, before downloading anything, releasing the item', async () => {
    let listings = 0
    /**
     * Lists the archive of the item, the first listing never answering.
     * @returns The files of the backend.
     */
    const listing = async (): Promise<RemoteFile[]> => {
      listings += 1
      return listings === 1 ? new Promise(() => {}) : [{ path: ITEM_PATH, size: 11, updatedAt: UPDATED_AT, version: 'v2' }]
    }
    const environment = environmentOf(postgresItem, Buffer.from('new archive'), listing)
    const cancel = new AbortController()
    const pull = environment.pull({ item: postgresItem, tables: null, signal: cancel.signal })
    setTimeout(() => cancel.abort(new Error('cancelled')), 100)

    await expect(pull).rejects.toBeInstanceOf(TransferCancelledError)
    expect(downloads).toBe(0)
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
    expect(await environment.pull({ item: postgresItem, tables: null })).toEqual({ done: true, detail: 'database restored in db' })
  }, 5_000)

  it('gives up a backend that does not answer, closing what it opens later', async () => {
    let release = (): void => undefined
    downloadGate = new Promise(resolve => {
      release = resolve
    })
    const late = new PassThrough()
    const cancel = new AbortController()
    const pull = environmentOf(postgresItem, late).pull({ item: postgresItem, tables: null, signal: cancel.signal })
    await vi.waitFor(() => expect(downloads).toBe(1))
    cancel.abort(new Error('cancelled'))

    await expect(pull).rejects.toBeInstanceOf(TransferCancelledError)
    release()
    await vi.waitFor(() => expect(late.destroyed).toBe(true))
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
  }, 5_000)

  it('stops a download whose backend stalls, closing its stream', async () => {
    const stalled = new PassThrough()
    stalled.write('half an archive')
    const cancel = new AbortController()
    const pull = environmentOf(postgresItem, stalled).pull({ item: postgresItem, tables: null, signal: cancel.signal })
    setTimeout(() => cancel.abort(new Error('cancelled')), 100)

    await expect(pull).rejects.toBeInstanceOf(TransferCancelledError)
    expect(stalled.destroyed).toBe(true)
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
  }, 5_000)

  it('keeps a file as it was when cancelled once downloaded but before it is replaced', async () => {
    const item: EnvironmentItem = { kind: 'file', path: 'api/notes.txt', ...open, ignore: null }
    const notes = path.join(folder, 'env', 'api', 'notes.txt')
    await fs.writeFile(notes, 'local notes')
    const cancel = new AbortController()
    const content = Readable.from([Buffer.from('pulled notes')])
    content.on('end', () => {
      cancel.abort(new Error('cancelled'))
    })

    await expect(environmentOf(item, content).pull({ item, tables: null, signal: cancel.signal })).rejects.toBeInstanceOf(TransferCancelledError)
    expect(await fs.readFile(notes, 'utf-8')).toBe('local notes')
    expect((await fs.readdir(path.join(folder, 'env', 'api'))).sort()).toEqual(['db.dump', 'notes.txt'])
  })

  it('keeps a configuration file merged key by key as it was when cancelled once its copy is downloaded', async () => {
    const item: EnvironmentItem = { kind: 'file', path: 'api/app.yml', ...open, ignore: null }
    const config = path.join(folder, 'env', 'api', 'app.yml')
    await fs.writeFile(config, 'port: 1\n')
    const cancel = new AbortController()
    const content = Readable.from([Buffer.from('port: 2\n')])
    content.on('end', () => {
      cancel.abort(new Error('cancelled'))
    })

    await expect(environmentOf(item, content).pull({ item, tables: null, keys: [{ path: ['port'], side: 'remote' }], signal: cancel.signal })).rejects.toBeInstanceOf(TransferCancelledError)
    expect(await fs.readFile(config, 'utf-8')).toBe('port: 1\n')
    expect((await fs.readdir(path.join(folder, 'env', 'api'))).sort()).toEqual(['app.yml', 'db.dump'])
  })

  it('relays nothing a backend reports once its download is cancelled', async () => {
    let report: ((done: number, total: number | null) => void) | undefined
    const backend: EnvironmentBackend = {
      list: async () => [{ path: ITEM_PATH, size: 100, updatedAt: UPDATED_AT, version: 'v2' }],
      download: async (_path, { onProgress } = {}) => {
        report = onProgress
        onProgress?.(10, 100)
        return new PassThrough()
      },
      upload: async () => undefined,
      remove: async () => undefined,
      close: async () => undefined
    }
    const context: BackendContext = { resolve: async text => text, askSecret: async () => '', cacheDir: folder, configFolder: folder, auth: null }
    const options = { folder: path.join(folder, 'env'), backends: [], defaultBackend: 'team', items: [postgresItem], configFiles: [], autoPulls: [], sections: { by: 'folder' as const, names: new Map<string, string>() }, s3: null }
    const reports: [number, number | null][] = []
    const cancel = new AbortController()
    const pull = new Environment(new Map([['team', backend]]), options, context).pull({
      item: postgresItem,
      tables: null,
      signal: cancel.signal,
      onProgress: (done, total) => {
        reports.push([done, total])
      }
    })
    await vi.waitFor(() => expect(reports).toEqual([[10, 100]]))
    cancel.abort(new Error('cancelled'))
    report?.(20, 100)

    await expect(pull).rejects.toBeInstanceOf(TransferCancelledError)
    report?.(30, 100)
    expect(reports).toEqual([[10, 100]])
  }, 5_000)

  it('restores to its end once the archive is complete, the download reported whole first', async () => {
    const started = path.join(folder, 'restore-started')
    const released = path.join(folder, 'restore-released')
    await fakeDocker(`touch "${started}"; while [ ! -f "${released}" ]; do sleep 0.05; done; cat "${path.join(folder, 'env', 'api', 'db.dump')}" > "${path.join(folder, 'seen')}"`)
    const cancel = new AbortController()
    const reports: [number, number | null][] = []
    const pull = environmentOf(postgresItem, Buffer.from('new archive')).pull({
      item: postgresItem,
      tables: null,
      signal: cancel.signal,
      onProgress: (done, total) => {
        reports.push([done, total])
      }
    })
    await vi.waitFor(async () => fs.access(started), { timeout: 5_000 })
    cancel.abort(new Error('cancelled'))
    await fs.writeFile(released, '')

    expect(await pull).toEqual({ done: true, detail: 'database restored in db' })
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'new archive' })
    expect(reports.at(-1)).toEqual([11, 11])
  }, 10_000)
})

describe('progress of a transfer', () => {
  it('relays what the backend reports of a pull and of a push', async () => {
    const item: EnvironmentItem = { kind: 'file', path: 'api/notes.txt', ...open, ignore: null }
    const environment = environmentOf(item, Buffer.from('pulled notes'))
    const reports: [number, number | null][] = []
    /**
     * Records a report of a transfer.
     * @param done - The bytes moved.
     * @param total - The size of the file.
     */
    const onProgress = (done: number, total: number | null): void => {
      reports.push([done, total])
    }

    await environment.pull({ item, tables: null, onProgress })
    await fs.writeFile(path.join(folder, 'env', 'api', 'notes.txt'), 'local')
    await environment.push({ item, tables: null, onProgress })
    expect(reports).toEqual([[11, 12], [12, 12], [4, 5], [5, 5]])
  })

  it('completes a progress whose backend does not know the size with the size it listed, reaching it once written', async () => {
    const item: EnvironmentItem = { kind: 'file', path: 'api/notes.txt', ...open, ignore: null }
    const backend: EnvironmentBackend = {
      list: async () => [{ path: item.path, size: 12, updatedAt: UPDATED_AT, version: 'v2' }],
      download: async (_path, { onProgress } = {}) => {
        onProgress?.(5, null)
        onProgress?.(14, null)
        return Readable.from([Buffer.from('pulled notes')])
      },
      upload: async () => undefined,
      remove: async () => undefined,
      close: async () => undefined
    }
    const context: BackendContext = { resolve: async text => text, askSecret: async () => '', cacheDir: folder, configFolder: folder, auth: null }
    const options = { folder: path.join(folder, 'env'), backends: [], defaultBackend: 'team', items: [item], configFiles: [], autoPulls: [], sections: { by: 'folder' as const, names: new Map<string, string>() }, s3: null }
    const reports: [number, number | null][] = []

    await new Environment(new Map([['team', backend]]), options, context).pull({
      item,
      tables: null,
      onProgress: (done, total) => {
        reports.push([done, total])
      }
    })
    expect(reports).toEqual([[5, 12], [11, 12], [12, 12]])
  })

  it('leaves the total unknown when neither the backend nor its listing knows the size', async () => {
    const item: EnvironmentItem = { kind: 'file', path: 'api/notes.txt', ...open, ignore: null }
    const backend: EnvironmentBackend = {
      list: async () => [{ path: item.path, size: null, updatedAt: UPDATED_AT, version: 'v2' }],
      download: async (_path, { onProgress } = {}) => {
        onProgress?.(5, null)
        return Readable.from([Buffer.from('pulled notes')])
      },
      upload: async () => undefined,
      remove: async () => undefined,
      close: async () => undefined
    }
    const context: BackendContext = { resolve: async text => text, askSecret: async () => '', cacheDir: folder, configFolder: folder, auth: null }
    const options = { folder: path.join(folder, 'env'), backends: [], defaultBackend: 'team', items: [item], configFiles: [], autoPulls: [], sections: { by: 'folder' as const, names: new Map<string, string>() }, s3: null }
    const environment = new Environment(new Map([['team', backend]]), options, context)
    const reports: [number, number | null][] = []

    await environment.pull({
      item,
      tables: null,
      onProgress: (done, total) => {
        reports.push([done, total])
      }
    })
    expect(reports).toEqual([[5, null], [12, 12]])
    expect((await environment.describe()).items[0].remote).toMatchObject({ size: null })
  })

  it('tells an empty file only once it is transferred, whatever its backend reports meanwhile', async () => {
    const item: EnvironmentItem = { kind: 'file', path: 'api/notes.txt', ...open, ignore: null }
    await fs.writeFile(path.join(folder, 'env', 'api', 'notes.txt'), '')
    const backend: EnvironmentBackend = {
      list: async () => [],
      download: async () => null,
      upload: async (_path, _localFile, _mediaType, { onProgress } = {}) => {
        onProgress?.(255, 0)
      },
      remove: async () => undefined,
      close: async () => undefined
    }
    const context: BackendContext = { resolve: async text => text, askSecret: async () => '', cacheDir: folder, configFolder: folder, auth: null }
    const options = { folder: path.join(folder, 'env'), backends: [], defaultBackend: 'team', items: [item], configFiles: [], autoPulls: [], sections: { by: 'folder' as const, names: new Map<string, string>() }, s3: null }
    const reports: [number, number | null][] = []

    await new Environment(new Map([['team', backend]]), options, context).push({
      item,
      tables: null,
      onProgress: (done, total) => {
        reports.push([done, total])
      }
    })
    expect(reports).toEqual([[0, 0]])
  })

  it('never moves a progress back nor to its total before the file is written', async () => {
    const item: EnvironmentItem = { kind: 'file', path: 'api/notes.txt', ...open, ignore: null }
    const backend: EnvironmentBackend = {
      list: async () => [{ path: item.path, size: 12, updatedAt: UPDATED_AT, version: 'v2' }],
      download: async (_path, { onProgress } = {}) => {
        onProgress?.(7, 12)
        onProgress?.(3, 12)
        onProgress?.(12, 12)
        return Readable.from([Buffer.from('pulled notes')])
      },
      upload: async () => undefined,
      remove: async () => undefined,
      close: async () => undefined
    }
    const context: BackendContext = { resolve: async text => text, askSecret: async () => '', cacheDir: folder, configFolder: folder, auth: null }
    const options = { folder: path.join(folder, 'env'), backends: [], defaultBackend: 'team', items: [item], configFiles: [], autoPulls: [], sections: { by: 'folder' as const, names: new Map<string, string>() }, s3: null }
    const reports: [number, number | null][] = []

    await new Environment(new Map([['team', backend]]), options, context).pull({
      item,
      tables: null,
      onProgress: (done, total) => {
        reports.push([done, total])
      }
    })
    expect(reports).toEqual([[7, 12], [7, 12], [11, 12], [12, 12]])
  })

  it('relays the progress of a configuration file pushed key by key', async () => {
    const item: EnvironmentItem = { kind: 'file', path: 'api/config.yml', ...open, ignore: null }
    await fs.writeFile(path.join(folder, 'env', 'api', 'config.yml'), 'port: 2\n')
    const reports: [number, number | null][] = []
    await environmentOf(item, Buffer.from('port: 1\n')).push({
      item,
      tables: null,
      keys: [{ path: ['port'], side: 'local' }],
      onProgress: (done, total) => {
        reports.push([done, total])
      }
    })
    expect(reports).toEqual([[7, 8], [8, 8]])
  })
})
