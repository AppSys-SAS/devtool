import { Redis } from 'ioredis'
import type { ArchiveRecord, ArchiveWriter, RecordHeader } from './archive.js'

/**
 * Names a Redis database by its server and number, without credentials.
 *
 * @param url - The database.
 * @returns The server and the database number, such as `localhost:6379/0`.
 */
export function redisDatabaseName (url: string): string {
  const parsed = new URL(url)
  return `${parsed.host}/${parsed.pathname.replace(/^\//, '') || '0'}`
}

/**
 * Gives the group of a key: the key up to its last colon followed by `*`, or the key itself when
 * it has no colon.
 *
 * @param key - The key.
 * @returns The group, such as `session:*`.
 */
export function redisKeyGroup (key: Buffer): string {
  const name = key.toString('utf-8')
  const end = name.lastIndexOf(':')
  return end < 0 ? name : `${name.slice(0, end + 1)}*`
}

/**
 * Gives the group of the key of a snapshot record.
 *
 * @param header - The header of a key record.
 * @returns The group, or null when the record holds no key.
 */
export function redisRecordGroup (header: RecordHeader): string | null {
  return header.type === 'key' && typeof header.key === 'string' ? redisKeyGroup(Buffer.from(header.key, 'base64')) : null
}

/**
 * Connects to a Redis database, failing at once when the server cannot be reached.
 *
 * @param url - The database, its number at the end of the URL.
 * @returns The connected client.
 */
async function connect (url: string): Promise<Redis> {
  const client = new Redis(url, { lazyConnect: true, retryStrategy: () => null })
  await client.connect()
  return client
}

/**
 * Runs an operation on a Redis database, closing the connection afterwards.
 *
 * @param url - The database.
 * @param operation - The operation.
 * @returns What the operation returns.
 */
async function withRedis<T> (url: string, operation: (client: Redis) => Promise<T>): Promise<T> {
  const client = await connect(url)
  try {
    return await operation(client)
  } finally {
    await client.quit().catch(() => client.disconnect())
  }
}

/**
 * Lists every key of a database once.
 *
 * @param client - The connected client.
 * @returns The keys.
 */
async function* keysOf (client: Redis): AsyncGenerator<Buffer> {
  const seen = new Set<string>()
  for await (const keys of client.scanBufferStream({ count: 1000 }) as AsyncIterable<Buffer[]>) {
    for (const key of keys) {
      const name = key.toString('base64')
      if (!seen.has(name)) {
        seen.add(name)
        yield key
      }
    }
  }
}

/**
 * Reads a whole record body.
 *
 * @param body - The body.
 * @returns Its bytes.
 */
async function bytesOf (body: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of body) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Lists the key groups of a Redis database.
 *
 * @param url - The database.
 * @returns The groups, sorted.
 */
export async function listRedisGroups (url: string): Promise<string[]> {
  return withRedis(url, async client => {
    const groups = new Set<string>()
    for await (const key of keysOf(client)) {
      groups.add(redisKeyGroup(key))
    }
    return [...groups].sort()
  })
}

/**
 * Writes keys of a Redis database to an archive, one record per key with its serialized value and
 * its remaining time to live.
 *
 * @param url - The database.
 * @param archive - The archive being written.
 * @param groups - The key groups to write, or null for every key.
 * @returns The number of keys written.
 */
export async function snapshotRedis (url: string, archive: ArchiveWriter, groups: string[] | null): Promise<number> {
  return withRedis(url, async client => {
    let count = 0
    for await (const key of keysOf(client)) {
      if (groups !== null && !groups.includes(redisKeyGroup(key))) {
        continue
      }

      const value = await client.dumpBuffer(key)
      const ttl = await client.pttl(key)
      if (value !== null && ttl !== -2) {
        await archive.add({ type: 'key', key: key.toString('base64'), ttl: Math.max(ttl, 0) }, [value])
        count += 1
      }
    }
    return count
  })
}

/**
 * Loads the keys of snapshot records in a Redis database, leaving its other databases as they are:
 * the database is emptied first, or only the chosen key groups are.
 *
 * @param url - The database.
 * @param records - The key records of a Redis snapshot.
 * @param groups - The key groups to restore, or null for the whole database.
 * @returns The number of keys restored and their groups.
 */
export async function restoreRedis (url: string, records: AsyncIterable<ArchiveRecord>, groups: string[] | null): Promise<{ count: number, groups: Set<string> }> {
  return withRedis(url, async client => {
    if (groups === null) {
      await client.flushdb()
    } else {
      for await (const key of keysOf(client)) {
        if (groups.includes(redisKeyGroup(key))) {
          await client.unlink(key)
        }
      }
    }

    const restored = new Set<string>()
    let count = 0
    for await (const { header, body } of records) {
      const group = redisRecordGroup(header)
      if (group === null || typeof header.ttl !== 'number') {
        throw new Error('not a Redis snapshot')
      }

      if (groups === null || groups.includes(group)) {
        await client.restore(Buffer.from(header.key as string, 'base64'), header.ttl, await bytesOf(body), 'REPLACE')
        restored.add(group)
        count += 1
      }
    }
    return { count, groups: restored }
  })
}
