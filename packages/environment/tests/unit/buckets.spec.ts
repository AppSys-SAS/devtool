import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createGzip, gzipSync } from 'node:zlib'
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ArchiveRecord, transformed } from '../../src/archive.js'
import type { BackendContext, EnvironmentBackend } from '../../src/backends/backend.js'
import { type BucketObject, checkTar, objectsOfArchive, objectsOfTar, restoreBucket, snapshotBucketTar } from '../../src/buckets.js'
import { Environment, type EnvironmentItem } from '../../src/environment.js'
import { writeTar } from '../../src/tar.js'
import { paxRecord, rawEntry, TAR_END } from './tar-fixtures.js'

let folder: string

/** An object kept by the fake S3 server. */
interface StoredObject {
  body: Buffer
  contentType: string | undefined
}

/**
 * Builds an S3 client keeping one bucket in memory.
 * @param objects - The objects of the bucket, by key.
 * @param storedKey - Gives the key the server stores an object under.
 * @returns The client.
 */
function memoryClient (objects: Map<string, StoredObject>, storedKey = (key: string): string => key): S3Client {
  const send = async (command: unknown): Promise<unknown> => {
    if (command instanceof ListObjectsV2Command) {
      return { Contents: [...objects].map(([Key, object]) => ({ Key, Size: object.body.length })), IsTruncated: false }
    }
    if (command instanceof GetObjectCommand) {
      const object = objects.get(command.input.Key!)!
      return { Body: Readable.from([object.body]), ContentLength: object.body.length, ContentType: object.contentType, LastModified: new Date('2026-01-02T03:04:05Z') }
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const { Key } of command.input.Delete!.Objects!) {
        objects.delete(Key!)
      }
      return {}
    }
    if (command instanceof PutObjectCommand) {
      const chunks: Buffer[] = []
      for await (const chunk of command.input.Body as Readable) {
        chunks.push(chunk as Buffer)
      }
      objects.set(storedKey(command.input.Key!), { body: Buffer.concat(chunks), contentType: command.input.ContentType })
      return {}
    }
    return {}
  }
  return { send } as unknown as S3Client
}

/**
 * Reads the keys of objects, reading each body.
 * @param objects - The objects.
 * @returns Their keys.
 */
async function keysOf (objects: AsyncIterable<BucketObject>): Promise<string[]> {
  const keys: string[] = []
  for await (const { key, body } of objects) {
    for await (const chunk of body) {
      void chunk
    }
    keys.push(key)
  }
  return keys
}

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-buckets-'))
})

afterEach(async () => {
  await fs.rm(folder, { recursive: true, force: true })
})

describe('native bucket archives', () => {
  it('writes the objects of a bucket to a tar.gz restored into another bucket, media types guessed from the keys', async () => {
    const source = new Map<string, StoredObject>([
      ['logo.png', { body: Buffer.from('png'), contentType: 'image/png' }],
      ['docs/readme.md', { body: Buffer.from('# hello'), contentType: 'text/markdown' }]
    ])
    const archive = path.join(folder, 'uploads.tar.gz')
    expect(await snapshotBucketTar(memoryClient(source), 'uploads', archive)).toBe(2)

    const target = new Map<string, StoredObject>([['stale.txt', { body: Buffer.from('old'), contentType: 'text/plain' }]])
    expect(await restoreBucket(memoryClient(target), 'uploads', objectsOfTar(createReadStream(archive)))).toBe(2)
    expect(Object.fromEntries([...target].map(([key, object]) => [key, [object.body.toString(), object.contentType]]))).toEqual({
      'logo.png': ['png', 'image/png'],
      'docs/readme.md': ['# hello', 'text/markdown']
    })
  })

  it('stores a file of an unknown type as bytes', async () => {
    const archive = transformed(writeTar(Readable.from([{ name: 'blob.unknownext', size: 1, body: Readable.from([Buffer.from('x')]) }])), createGzip())
    const objects = []
    for await (const { key, contentType, body } of objectsOfTar(archive)) {
      for await (const chunk of body) {
        void chunk
      }
      objects.push([key, contentType])
    }
    expect(objects).toEqual([['blob.unknownext', 'application/octet-stream']])
  })

  it('closes the objects when storing one fails', async () => {
    let closed = false
    const objects = (async function* (): AsyncGenerator<BucketObject> {
      try {
        yield { key: 'a.txt', size: 1, contentType: 'text/plain', body: Readable.from([Buffer.from('a')]) }
        yield { key: 'b.txt', size: 1, contentType: 'text/plain', body: Readable.from([Buffer.from('b')]) }
      } finally {
        closed = true
      }
    })()
    const client = { send: async (command: unknown) => (command instanceof PutObjectCommand ? Promise.reject(new Error('disk full')) : { Contents: [] }) } as unknown as S3Client

    await expect(restoreBucket(client, 'uploads', objects)).rejects.toThrow('disk full')
    expect(closed).toBe(true)
  })

  it('deletes the objects the snapshot does not hold only once every object is stored', async () => {
    const target = new Map<string, StoredObject>([
      ['stale.txt', { body: Buffer.from('old'), contentType: 'text/plain' }],
      ['a.txt', { body: Buffer.from('old a'), contentType: 'text/plain' }]
    ])
    const failing = (async function* (): AsyncGenerator<BucketObject> {
      yield { key: 'a.txt', size: 5, contentType: 'text/plain', body: Readable.from([Buffer.from('new a')]) }
      throw new Error('archive cut')
    })()
    await expect(restoreBucket(memoryClient(target), 'uploads', failing)).rejects.toThrow('archive cut')
    expect([...target.keys()].sort()).toEqual(['a.txt', 'stale.txt'])

    const whole = (async function* (): AsyncGenerator<BucketObject> {
      yield { key: 'a.txt', size: 5, contentType: 'text/plain', body: Readable.from([Buffer.from('new a')]) }
      yield { key: 'b.txt', size: 1, contentType: 'text/plain', body: Readable.from([Buffer.from('b')]) }
    })()
    expect(await restoreBucket(memoryClient(target), 'uploads', whole)).toBe(2)
    expect(Object.fromEntries([...target].map(([key, object]) => [key, object.body.toString()]))).toEqual({ 'a.txt': 'new a', 'b.txt': 'b' })
  })

  it('deletes only objects the bucket held before, keeping an object the server stored under another key', async () => {
    const target = new Map<string, StoredObject>([['old.txt', { body: Buffer.from('old'), contentType: 'text/plain' }]])
    const objects = (async function* (): AsyncGenerator<BucketObject> {
      yield { key: 'plain.txt', size: 1, contentType: 'text/plain', body: Readable.from([Buffer.from('p')]) }
      yield { key: '/lead.txt', size: 1, contentType: 'text/plain', body: Readable.from([Buffer.from('l')]) }
    })()
    await restoreBucket(memoryClient(target, key => key.replace(/^\/+/, '')), 'uploads', objects)

    expect([...target.keys()].sort()).toEqual(['lead.txt', 'plain.txt'])
  })

  it.each(['/lead.txt', 'a//b.txt', 'a/./b.txt', 'a/../b.txt', '..', 'a/ ./b.txt', 'a/ .. /b.txt'])('refuses an archive holding the key %s, which a server may store under another key', async key => {
    const tar = gzipSync(Buffer.concat([rawEntry('a.txt', '0', 'a'), rawEntry(key, '0', 'x'), TAR_END]))
    await expect(checkTar(Readable.from([tar]))).rejects.toThrow('could be stored under another key')
    const records = (async function* (): AsyncGenerator<ArchiveRecord> {
      yield { header: { type: 'object', key, size: 0 }, body: Readable.from([]) }
    })()
    await expect(objectsOfArchive(records).next()).rejects.toThrow('could be stored under another key')
  })

  it('keeps a folder marker, a key ending with a slash, in a snapshot and in a tar archive, and skips the folders of a tar archive', async () => {
    const records = (async function* (): AsyncGenerator<ArchiveRecord> {
      yield { header: { type: 'object', key: 'photos/', size: 0 }, body: Readable.from([]) }
    })()
    expect(await keysOf(objectsOfArchive(records))).toEqual(['photos/'])

    const source = new Map<string, StoredObject>([
      ['photos/', { body: Buffer.alloc(0), contentType: 'application/x-directory' }],
      ['photos/a.jpg', { body: Buffer.from('a'), contentType: 'image/jpeg' }]
    ])
    const archivePath = path.join(folder, 'uploads.tar.gz')
    expect(await snapshotBucketTar(memoryClient(source), 'uploads', archivePath)).toBe(2)
    expect(await keysOf(objectsOfTar(createReadStream(archivePath)))).toEqual(['photos/', 'photos/a.jpg'])

    const folders = gzipSync(Buffer.concat([rawEntry('docs/', '5', ''), rawEntry('docs/a.txt', '0', 'a'), TAR_END]))
    expect(await keysOf(objectsOfTar(Readable.from([folders])))).toEqual(['docs/a.txt'])
  })

  it('refuses to snapshot a bucket holding a key it could not be restored under', async () => {
    const source = new Map<string, StoredObject>([['a//b.txt', { body: Buffer.from('b'), contentType: 'text/plain' }]])
    await expect(snapshotBucketTar(memoryClient(source), 'uploads', path.join(folder, 'uploads.tar.gz'))).rejects.toThrow('the object key "a//b.txt" could be stored under another key')
  })

  it('fails when the server refuses to delete an object the snapshot does not hold', async () => {
    const target = new Map<string, StoredObject>([['locked.txt', { body: Buffer.from('l'), contentType: 'text/plain' }]])
    const memory = memoryClient(target)
    const client = {
      send: async (command: unknown) => (command instanceof DeleteObjectsCommand ? { Errors: [{ Key: 'locked.txt', Code: 'AccessDenied', Message: 'Access Denied' }] } : memory.send(command as never))
    } as unknown as S3Client
    const objects = (async function* (): AsyncGenerator<BucketObject> {
      yield { key: 'a.txt', size: 1, contentType: 'text/plain', body: Readable.from([Buffer.from('a')]) }
    })()

    await expect(restoreBucket(client, 'uploads', objects)).rejects.toThrow('objects the snapshot does not hold could not be deleted: locked.txt (Access Denied)')
  })

  it('leaves the bucket as it is when the archive cannot be read', async () => {
    const target = new Map<string, StoredObject>([['kept.txt', { body: Buffer.from('kept'), contentType: 'text/plain' }]])
    await expect(restoreBucket(memoryClient(target), 'uploads', objectsOfTar(Readable.from([Buffer.from('not gzip')])))).rejects.toThrow()
    expect([...target.keys()]).toEqual(['kept.txt'])
  })

  it('leaves the bucket as it is when the first entry of the archive has an invalid size', async () => {
    const target = new Map<string, StoredObject>([['kept.txt', { body: Buffer.from('kept'), contentType: 'text/plain' }]])
    const archive = gzipSync(Buffer.concat([rawEntry('PaxHeader', 'x', paxRecord('size', '0.5')), rawEntry('a.txt', '0', 'a'), TAR_END]))
    await expect(restoreBucket(memoryClient(target), 'uploads', objectsOfTar(Readable.from([archive])))).rejects.toThrow('invalid size 0.5')
    expect([...target.keys()]).toEqual(['kept.txt'])
  })

  it('finds an archive cut in the body of a later entry incomplete', async () => {
    const whole = Buffer.concat([rawEntry('a.txt', '0', 'a'), rawEntry('b.bin', '0', 'x'.repeat(2000)), TAR_END])
    await expect(checkTar(Readable.from([gzipSync(whole)]))).resolves.toBeUndefined()
    await expect(checkTar(Readable.from([gzipSync(whole.subarray(0, 1536))]))).rejects.toThrow()
  })

  it('refuses a truncated native bucket archive before reaching the S3 server', async () => {
    const whole = Buffer.concat([rawEntry('a.txt', '0', 'a'), rawEntry('b.bin', '0', 'x'.repeat(2000)), TAR_END])
    const item: EnvironmentItem = { kind: 'bucket', path: 'api/uploads.tar.gz', backend: 'team', encryption: null, groups: { pull: null, push: null }, bucket: 'uploads', format: 'native' }
    const backend: EnvironmentBackend = {
      list: async () => [],
      download: async () => Readable.from([gzipSync(whole.subarray(0, 1536))]),
      upload: async () => undefined,
      remove: async () => undefined,
      close: async () => undefined
    }
    const context: BackendContext = { resolve: async text => text, askSecret: async () => '', cacheDir: folder, configFolder: folder, auth: null }
    const environment = new Environment(new Map([['team', backend]]), { folder, backends: [], defaultBackend: 'team', items: [item], configFiles: [], autoPulls: [], sections: { by: 'folder', names: new Map() }, s3: null }, context)

    await expect(environment.pull({ item, tables: null })).rejects.toThrow('api/uploads.tar.gz is not a complete tar.gz archive')
  })
})
