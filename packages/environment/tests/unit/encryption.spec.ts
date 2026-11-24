import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendContext, EnvironmentBackend, RemoteFile } from '../../src/backends/backend.js'
import { decrypt, encrypt, encrypted, EncryptionSecret, keyFileKey, passwordFileKey, plainLengthOf, readEncryption } from '../../src/backends/encryption.js'

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
 * Builds a backend keeping its files in memory.
 * @returns The backend and its files.
 */
function memoryBackend (): { backend: EnvironmentBackend, files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>()
  const backend: EnvironmentBackend = {
    list: async (): Promise<RemoteFile[]> => [...files].map(([filePath, content]) => ({ path: filePath, size: content.length, updatedAt: new Date(0), version: String(content.length) })),
    download: async (filePath: string) => (files.has(filePath) ? Readable.from([files.get(filePath)!]) : null),
    upload: async (filePath: string, localFile: string) => {
      files.set(filePath, await fs.readFile(localFile))
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
    await expect(fs.stat(`${local}.sealed`)).rejects.toThrow()
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
