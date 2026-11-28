import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendContext, EnvironmentBackend, RemoteFile, TransferOptions } from '../../src/backends/backend.js'
import { decrypt, encrypt, encrypted, EncryptionSecret, keyFileKey, passwordFileKey, plainBytesOf, plainLengthOf, readEncryption } from '../../src/backends/encryption.js'
import { progressRecorder } from './progress-fixtures.js'

const KEY = randomBytes(32)

let folder: string

/**
 * Reads a whole stream.
 * @param stream - The stream.
 * @returns Its bytes.
 */
async function bytesOf (stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Builds a backend keeping its files in memory, reporting each transfer whole at once.
 * @returns The backend and its files.
 */
function memoryBackend (): { backend: EnvironmentBackend, files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>()
  const backend: EnvironmentBackend = {
    list: async (): Promise<RemoteFile[]> => [...files].map(([filePath, content]) => ({ path: filePath, size: content.length, updatedAt: new Date(0), version: String(content.length) })),
    download: async (filePath: string, { onProgress }: TransferOptions = {}) => {
      const content = files.get(filePath)
      onProgress?.(content?.length ?? 0, content?.length ?? null)
      return content ? Readable.from([content]) : null
    },
    upload: async (filePath: string, localFile: string, _mediaType: string, { onProgress }: TransferOptions = {}) => {
      files.set(filePath, await fs.readFile(localFile))
      onProgress?.(files.get(filePath)!.length, files.get(filePath)!.length)
    },
    remove: async (filePath: string) => {
      files.delete(filePath)
    },
    close: async () => undefined
  }
  return { backend, files }
}

/**
 * Builds a context whose value blocks are the text itself and whose prompts answer in turn.
 * @param answers - The secrets typed, one per prompt.
 * @returns The context and the labels asked.
 */
function contextOf (answers: string[] = []): { context: BackendContext, asked: string[] } {
  const asked: string[] = []
  const context: BackendContext = {
    resolve: async text => text,
    askSecret: async label => {
      asked.push(label)
      return answers.shift() ?? ''
    },
    cacheDir: os.tmpdir(),
    configFolder: os.tmpdir(),
    auth: null
  }
  return { context, asked }
}

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-encryption-'))
})

afterEach(async () => {
  await fs.rm(folder, { recursive: true, force: true })
})

describe('encrypt and decrypt', () => {
  it.each([0, 1, 65535, 65536, 65537, 200_000])('round trips %i bytes and gives back their size from the encrypted size', async length => {
    const content = randomBytes(length)
    const sealed = await bytesOf(encrypt(Readable.from([content]), keyFileKey(KEY), 'api/db.gz'))
    expect(plainLengthOf(sealed.length)).toBe(length)
    expect((await bytesOf(decrypt(Readable.from([sealed]), keyFileKey(KEY), 'api/db.gz'))).equals(content)).toBe(true)
  })

  it('round trips with a password, each file salted', async () => {
    const content = Buffer.from('secret configuration')
    const first = await bytesOf(encrypt(Readable.from([content]), passwordFileKey('correct horse'), 'api/config.yml'))
    const second = await bytesOf(encrypt(Readable.from([content]), passwordFileKey('correct horse'), 'api/config.yml'))
    expect(first.equals(second)).toBe(false)
    expect((await bytesOf(decrypt(Readable.from([first]), passwordFileKey('correct horse'), 'api/config.yml'))).toString()).toBe('secret configuration')
  })

  it('refuses another secret, another path, a changed or a cut file', async () => {
    const sealed = await bytesOf(encrypt(Readable.from([randomBytes(100_000)]), keyFileKey(KEY), 'api/db.gz'))
    await expect(bytesOf(decrypt(Readable.from([sealed]), keyFileKey(randomBytes(32)), 'api/db.gz'))).rejects.toThrow('wrong encryption secret')
    await expect(bytesOf(decrypt(Readable.from([sealed]), keyFileKey(KEY), 'web/db.gz'))).rejects.toThrow('wrong encryption secret')
    const changed = Buffer.from(sealed)
    changed[changed.length - 1] ^= 1
    await expect(bytesOf(decrypt(Readable.from([changed]), keyFileKey(KEY), 'api/db.gz'))).rejects.toThrow('wrong encryption secret')
    await expect(bytesOf(decrypt(Readable.from([sealed.subarray(0, 65_600)]), keyFileKey(KEY), 'api/db.gz'))).rejects.toThrow()
    await expect(bytesOf(decrypt(Readable.from([Buffer.from('plain text')]), keyFileKey(KEY), 'api/db.gz'))).rejects.toThrow()
  })
})

describe('readEncryption', () => {
  it('reads a key, a password or a prompt', () => {
    expect(readEncryption({ key: 'abc' }, 'x').encryption).toEqual({ key: 'abc' })
    expect(readEncryption({ password: '{{ op://dev/env/password }}' }, 'x').encryption).toEqual({ password: '{{ op://dev/env/password }}' })
    expect(readEncryption({ prompt: true }, 'x').encryption).toEqual({ prompt: true })
    expect(readEncryption(undefined, 'x')).toEqual({ encryption: null, problems: [] })
  })

  it.each([[{}], [{ key: 'a', password: 'b' }], [{ prompt: false }], ['abc'], [{ key: ' ' }]])('reports %j', value => {
    expect(readEncryption(value, 'environment.backends.team.encryption').problems).toEqual([
      { setting: 'environment.backends.team.encryption', message: 'must be { key } (32 bytes in base64), { password } or { prompt: true }' }
    ])
  })
})

describe('encrypted', () => {
  it('stores encrypted files and lists their plain size', async () => {
    const { backend, files } = memoryBackend()
    const { context } = contextOf()
    const store = encrypted(backend, new EncryptionSecret({ key: KEY.toString('base64') }, context, 'team'))
    const local = path.join(folder, 'config.yml')
    await fs.writeFile(local, 'name: acme\n')
    await store.upload('api/config.yml', local, 'application/yaml')
    expect(files.get('api/config.yml')!.includes(Buffer.from('acme'))).toBe(false)
    expect((await store.list())?.[0].size).toBe(11)
    expect((await bytesOf((await store.download('api/config.yml'))!)).toString()).toBe('name: acme\n')
    expect(await store.download('absent.yml')).toBeNull()
    expect(await fs.readdir(folder)).toEqual(['config.yml'])
  })

  it('reports the progress of the encrypted file its backend moves in bytes of content, as its listing does', async () => {
    const { backend, files } = memoryBackend()
    const store = encrypted(backend, new EncryptionSecret({ key: KEY.toString('base64') }, contextOf().context, 'team'))
    const local = path.join(folder, 'db.gz')
    await fs.writeFile(local, randomBytes(100_000))

    const sent = progressRecorder()
    await store.upload('api/db.gz', local, 'application/gzip', { onProgress: sent.onProgress })
    expect(files.get('api/db.gz')!.length).toBeGreaterThan(100_000)
    expect(sent.reports).toEqual([[100_000, 100_000]])

    const received = progressRecorder()
    await bytesOf((await store.download('api/db.gz', { onProgress: received.onProgress }))!)
    expect(received.reports).toEqual([[100_000, 100_000]])
    expect((await store.list())?.[0].size).toBe(100_000)
  })

  it.each([0, 1, 65535, 65536, 65537, 200_000])('counts %i bytes of content in their encrypted file, and none in its header', async length => {
    const sealed = await bytesOf(encrypt(Readable.from([randomBytes(length)]), keyFileKey(KEY), 'api/db.gz'))
    expect(plainBytesOf(sealed.length)).toBe(length)
    expect(plainBytesOf(10)).toBe(0)
  })

  it('passes the signal of a listing and the options of a transfer to its backend, and how its backend is bounded', async () => {
    const { backend } = memoryBackend()
    const list = vi.spyOn(backend, 'list')
    const download = vi.spyOn(backend, 'download')
    const store = encrypted(backend, new EncryptionSecret({ key: KEY.toString('base64') }, contextOf().context, 'team'))
    const cancel = new AbortController()

    await store.list(cancel.signal)
    await store.download('absent.gz', { signal: cancel.signal })
    expect(list).toHaveBeenCalledWith(cancel.signal)
    expect(download).toHaveBeenCalledWith('absent.gz', { signal: cancel.signal })
    expect(store.boundsItself).toBeUndefined()
    expect(encrypted({ ...backend, boundsItself: true }, new EncryptionSecret({ key: KEY.toString('base64') }, contextOf().context, 'team')).boundsItself).toBe(true)
  })

  it('stops encrypting an upload once cancelled, its backend never reached and no file left', async () => {
    const { backend } = memoryBackend()
    const upload = vi.spyOn(backend, 'upload')
    const store = encrypted(backend, new EncryptionSecret({ key: KEY.toString('base64') }, contextOf().context, 'team'))
    const local = path.join(folder, 'db.gz')
    await fs.writeFile(local, randomBytes(100_000))
    const cancel = new AbortController()
    cancel.abort(new Error('cancelled'))

    await expect(store.upload('api/db.gz', local, 'application/gzip', { signal: cancel.signal })).rejects.toThrow('cancelled')
    expect(upload).not.toHaveBeenCalled()
    expect(await fs.readdir(folder)).toEqual(['db.gz'])
  })

  it('stops an encryption cancelled while it runs, its backend never reached and no file left', async () => {
    const { backend } = memoryBackend()
    const upload = vi.spyOn(backend, 'upload')
    const store = encrypted(backend, new EncryptionSecret({ key: KEY.toString('base64') }, contextOf().context, 'team'))
    const local = path.join(folder, 'db.gz')
    await fs.writeFile(local, randomBytes(64 * 1024 * 1024))
    const cancel = new AbortController()
    const uploading = store.upload('api/db.gz', local, 'application/gzip', { signal: cancel.signal })
    await vi.waitFor(async () => {
      const sealed = (await fs.readdir(folder)).find(name => name.endsWith('.sealed'))
      expect(sealed && (await fs.stat(path.join(folder, sealed))).size).toBeGreaterThan(0)
    }, { timeout: 10_000, interval: 5 })
    cancel.abort(new Error('cancelled'))

    await expect(uploading).rejects.toThrow()
    expect(upload).not.toHaveBeenCalled()
    expect(await fs.readdir(folder)).toEqual(['db.gz'])
  }, 20_000)

  it('closes the stored file when its decrypted content is closed before being read', async () => {
    const { backend, files } = memoryBackend()
    const store = encrypted(backend, new EncryptionSecret({ key: KEY.toString('base64') }, contextOf().context, 'team'))
    const local = path.join(folder, 'db.gz')
    await fs.writeFile(local, randomBytes(1000))
    await store.upload('api/db.gz', local, 'application/gzip')
    const stored = Readable.from([files.get('api/db.gz')!])
    const plain = await encrypted({ ...backend, download: async () => stored }, new EncryptionSecret({ key: KEY.toString('base64') }, contextOf().context, 'team')).download('api/db.gz')

    plain!.destroy()
    await setImmediate()
    expect(stored.destroyed).toBe(true)
  })

  it('closes the stored file when its decrypted content is closed while waiting for it', async () => {
    const { backend } = memoryBackend()
    const stalled = new PassThrough()
    stalled.write(Buffer.alloc(10))
    const plain = await encrypted({ ...backend, download: async () => stalled }, new EncryptionSecret({ key: KEY.toString('base64') }, contextOf().context, 'team')).download('api/db.gz')
    plain!.resume()
    await setImmediate()

    plain!.destroy()
    await setImmediate()
    expect(stalled.destroyed).toBe(true)
  })

  it('keeps the secret when a download fails for another reason than the secret', async () => {
    const { backend, files } = memoryBackend()
    const { context, asked } = contextOf(['correct horse', 'correct horse'])
    const secret = new EncryptionSecret({ prompt: true }, context, 'team')
    const local = path.join(folder, 'db.gz')
    await fs.writeFile(local, randomBytes(1000))
    await encrypted(backend, secret).upload('api/db.gz', local, 'application/gzip')
    const failing = new PassThrough()
    failing.write(files.get('api/db.gz')!.subarray(0, 100))
    setTimeout(() => failing.destroy(new Error('connection reset')), 50)

    await expect(bytesOf((await encrypted({ ...backend, download: async () => failing }, secret).download('api/db.gz'))!)).rejects.toThrow('connection reset')
    await bytesOf((await encrypted(backend, secret).download('api/db.gz'))!)
    expect(asked).toEqual(['team'])
  })

  it('encrypts twice when a file and its backend both declare a secret', async () => {
    const { backend } = memoryBackend()
    const { context } = contextOf()
    const backendLayer = encrypted(backend, new EncryptionSecret({ key: KEY.toString('base64') }, context, 'team'))
    const fileLayer = encrypted(backendLayer, new EncryptionSecret({ password: 'per file' }, context, 'api/db.gz'))
    const local = path.join(folder, 'db.gz')
    await fs.writeFile(local, randomBytes(70_000))
    await fileLayer.upload('api/db.gz', local, 'application/gzip')
    expect((await bytesOf((await fileLayer.download('api/db.gz'))!)).equals(await fs.readFile(local))).toBe(true)
    await expect(bytesOf((await backendLayer.download('api/db.gz'))!)).resolves.not.toEqual(await fs.readFile(local))
  })

  it('asks the password once, and again after a wrong one', async () => {
    const { backend } = memoryBackend()
    const writer = contextOf(['right'])
    const local = path.join(folder, 'notes.env')
    await fs.writeFile(local, 'TOKEN=1\n')
    await encrypted(backend, new EncryptionSecret({ prompt: true }, writer.context, 'the file notes.env')).upload('notes.env', local, 'text/plain')

    const reader = contextOf(['wrong', 'right'])
    const store = encrypted(backend, new EncryptionSecret({ prompt: true }, reader.context, 'the file notes.env'))
    await expect(bytesOf((await store.download('notes.env'))!)).rejects.toThrow('wrong encryption secret')
    expect((await bytesOf((await store.download('notes.env'))!)).toString()).toBe('TOKEN=1\n')
    expect((await bytesOf((await store.download('notes.env'))!)).toString()).toBe('TOKEN=1\n')
    expect(reader.asked).toEqual(['the file notes.env', 'the file notes.env'])
  })
})
