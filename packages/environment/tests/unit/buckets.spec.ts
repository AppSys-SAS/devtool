import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createGzip, gzipSync } from 'node:zlib'
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { transformed } from '../../src/archive.js'
import type { BackendContext, EnvironmentBackend } from '../../src/backends/backend.js'
import { type BucketObject, checkTar, objectsOfTar, restoreBucket, snapshotBucketTar } from '../../src/buckets.js'
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
 * @returns The client.
 */
function memoryClient (objects: Map<string, StoredObject>): S3Client {
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
      objects.set(command.input.Key!, { body: Buffer.concat(chunks), contentType: command.input.ContentType })
      return {}
    }
    return {}
  }
  return { send } as unknown as S3Client
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
    const environment = new Environment(new Map([['team', backend]]), { folder, backends: [], defaultBackend: 'team', items: [item], configFiles: [], autoPulls: [], s3: null }, context)

    await expect(environment.pull({ item, tables: null })).rejects.toThrow('api/uploads.tar.gz is not a complete tar.gz archive')
  })
})
