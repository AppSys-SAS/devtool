import { Readable } from 'node:stream'
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import type { ArchiveRecord, ArchiveWriter } from './archive.js'

/** Local S3 server holding the buckets of the environment. */
export interface S3Options {
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  region: string
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
 * Writes every object of a bucket to an archive, one record per object with its media type.
 *
 * @param client - The S3 client.
 * @param bucket - The bucket.
 * @param archive - The archive being written.
 * @returns The number of objects.
 */
export async function snapshotBucket (client: S3Client, bucket: string, archive: ArchiveWriter): Promise<number> {
  let count = 0
  for await (const { key } of listObjects(client, bucket)) {
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    await archive.add(
      { type: 'object', key, contentType: object.ContentType ?? 'application/octet-stream', size: object.ContentLength ?? 0 },
      object.Body as Readable
    )
    count += 1
  }

  return count
}

/**
 * Replaces the content of a bucket, created when missing, by the objects of archive records.
 *
 * @param client - The S3 client.
 * @param bucket - The bucket.
 * @param records - The records of a bucket snapshot.
 * @returns The number of objects restored.
 */
export async function restoreBucket (client: S3Client, bucket: string, records: AsyncIterable<ArchiveRecord>): Promise<number> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
  }

  const keys: string[] = []
  for await (const { key } of listObjects(client, bucket)) {
    keys.push(key)
  }
  for (let start = 0; start < keys.length; start += 1000) {
    const batch = keys.slice(start, start + 1000).map(Key => ({ Key }))
    await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }))
  }

  let count = 0
  for await (const { header, body } of records) {
    if (header.type !== 'object' || typeof header.key !== 'string' || typeof header.size !== 'number') {
      throw new Error('not a bucket snapshot')
    }

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: header.key,
        Body: Readable.from(body, { objectMode: false }),
        ContentLength: header.size,
        ContentType: typeof header.contentType === 'string' ? header.contentType : undefined
      })
    )
    count += 1
  }

  return count
}
