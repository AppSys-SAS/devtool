import { Readable } from 'node:stream'
import { createGunzip, createGzip } from 'node:zlib'
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import mime from 'mime-types'
import { type ArchiveRecord, type ArchiveWriter, transformed } from './archive.js'
import { writeLocalFile } from './directory.js'
import { readTar, type TarEntry, writeTar } from './tar.js'

/** Local S3 server holding the buckets of the environment. */
export interface S3Options {
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  region: string
}

/** An object of a bucket with its content. */
export interface BucketObject {
  key: string
  size: number
  contentType: string | undefined
  /** Last change, unknown for an object read from an archive. */
  lastModified?: Date
  body: AsyncIterable<Buffer>
}

/**
 * Creates a client of the local S3 server.
 *
 * @param options - The server and its credentials.
 * @returns The client.
 */
export function createS3Client (options: S3Options): S3Client {
  return new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: true,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
  })
}

/**
 * Lists every object of a bucket.
 *
 * @param client - The S3 client.
 * @param bucket - The bucket.
 * @returns The keys and sizes of the objects.
 */
async function* listObjects (client: S3Client, bucket: string): AsyncGenerator<{ key: string, size: number }> {
  let token: string | undefined
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }))
    for (const object of page.Contents ?? []) {
      if (object.Key !== undefined) {
        yield { key: object.Key, size: object.Size ?? 0 }
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token !== undefined)
}

/**
 * Reads every object of a bucket, one at a time, failing on a key a snapshot could not be restored
 * under.
 *
 * @param client - The S3 client.
 * @param bucket - The bucket.
 * @returns The objects; each body must be read before the next object is.
 */
async function* readObjects (client: S3Client, bucket: string): AsyncGenerator<BucketObject> {
  for await (const { key } of listObjects(client, bucket)) {
    storableKey(key)
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    yield { key, size: object.ContentLength ?? 0, contentType: object.ContentType, lastModified: object.LastModified, body: object.Body as Readable }
  }
}

/**
 * Writes every object of a bucket to an archive, one record per object with its media type.
 *
 * @param client - The S3 client.
 * @param bucket - The bucket.
 * @param archive - The archive being written.
 * @returns The number of objects.
 */
export async function snapshotBucket (client: S3Client, bucket: string, archive: ArchiveWriter): Promise<number> {
  let count = 0
  for await (const { key, size, contentType, body } of readObjects(client, bucket)) {
    await archive.add({ type: 'object', key, contentType: contentType ?? 'application/octet-stream', size }, body)
    count += 1
  }

  return count
}

/**
 * Writes every object of a bucket to a gzip-compressed tar file, the key of each object being its
 * path in the archive.
 *
 * @param client - The S3 client.
 * @param bucket - The bucket.
 * @param filePath - The local file, replaced once fully written.
 * @returns The number of objects.
 */
export async function snapshotBucketTar (client: S3Client, bucket: string, filePath: string): Promise<number> {
  let count = 0
  const entries = async function* (): AsyncGenerator<TarEntry> {
    for await (const { key, size, lastModified, body } of readObjects(client, bucket)) {
      count += 1
      yield { name: key, size, mtime: lastModified, body }
    }
  }
  await writeLocalFile(filePath, transformed(writeTar(entries()), createGzip()))
  return count
}

/**
 * Checks that an S3 server stores an object under the key it is given: an empty key, or a key with
 * an empty segment other than a final slash, or a `.` or `..` segment, spaces around it or not, may
 * be stored under another key or refused.
 *
 * @param key - The key.
 * @returns The key.
 */
function storableKey (key: string): string {
  const segments = key.split('/')
  const rewritten = segments.some((segment, index) => ['.', '..'].includes(segment.trim()) || (segment === '' && index < segments.length - 1))
  if (key === '' || rewritten) {
    throw new Error(`the object key "${key}" could be stored under another key: write keys without empty, . or .. segments`)
  }
  return key
}

/**
 * Reads the objects of the records of a bucket snapshot.
 *
 * @param records - The records.
 * @returns The objects.
 */
export async function* objectsOfArchive (records: AsyncIterable<ArchiveRecord>): AsyncGenerator<BucketObject> {
  for await (const { header, body } of records) {
    if (header.type !== 'object' || typeof header.key !== 'string' || typeof header.size !== 'number') {
      throw new Error('not a bucket snapshot')
    }
    yield { key: storableKey(header.key), size: header.size, contentType: typeof header.contentType === 'string' ? header.contentType : undefined, body }
  }
}

/**
 * Reads the files of a gzip-compressed tar archive as objects, their media type guessed from their name.
 *
 * @param archive - The archive.
 * @returns The objects, keyed by their path in the archive.
 */
export async function* objectsOfTar (archive: AsyncIterable<Buffer>): AsyncGenerator<BucketObject> {
  for await (const { name, size, body } of readTar(transformed(archive, createGunzip()))) {
    yield { key: storableKey(name), size, contentType: mime.lookup(name) || 'application/octet-stream', body }
  }
}

/**
 * Reads a whole gzip-compressed tar archive of objects, failing when it is truncated or corrupted.
 *
 * @param archive - The archive.
 */
export async function checkTar (archive: AsyncIterable<Buffer>): Promise<void> {
  for await (const { body } of objectsOfTar(archive)) {
    for await (const chunk of body) {
      void chunk
    }
  }
}

/**
 * Replaces the content of a bucket, created when missing, by some objects: every object is stored
 * first, then the objects the bucket held before and that are not among them are deleted, so a
 * failure deletes nothing, though objects already stored hold their new content.
 *
 * @param client - The S3 client.
 * @param bucket - The bucket.
 * @param objects - The objects.
 * @returns The number of objects the bucket holds once restored.
 */
export async function restoreBucket (client: S3Client, bucket: string, objects: AsyncIterable<BucketObject>): Promise<number> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
  }

  const held: string[] = []
  for await (const { key } of listObjects(client, bucket)) {
    held.push(key)
  }
  const restored = new Set<string>()
  for await (const { key, size, contentType, body } of objects) {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: Readable.from(body, { objectMode: false }),
        ContentLength: size,
        ContentType: contentType
      })
    )
    restored.add(key)
  }

  const stale = held.filter(key => !restored.has(key))
  for (let start = 0; start < stale.length; start += 1000) {
    const batch = stale.slice(start, start + 1000).map(Key => ({ Key }))
    const { Errors: errors = [] } = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }))
    if (errors.length > 0) {
      throw new Error(`objects the snapshot does not hold could not be deleted: ${errors.map(error => `${error.Key} (${error.Message ?? error.Code})`).join(', ')}`)
    }
  }
  return restored.size
}
