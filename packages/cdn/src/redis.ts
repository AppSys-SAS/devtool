import { Redis } from "ioredis";
import type { ArchiveRecord, ArchiveWriter } from "./archive.js";

/**
 * Names a Redis database by its server and number, without credentials.
 *
 * @param url - The database.
 * @returns The server and the database number, such as `localhost:6379/0`.
 */
export function redisDatabaseName(url: string): string {
  const parsed = new URL(url);
  return `${parsed.host}/${parsed.pathname.replace(/^\//, "") || "0"}`;
}

/**
 * Connects to a Redis database, failing at once when the server cannot be reached.
 *
 * @param url - The database, its number at the end of the URL.
 * @returns The connected client.
 */
async function connect(url: string): Promise<Redis> {
  const client = new Redis(url, { lazyConnect: true, retryStrategy: () => null });
  await client.connect();
  return client;
}

/**
 * Runs an operation on a Redis database, closing the connection afterwards.
 *
 * @param url - The database.
 * @param operation - The operation.
 * @returns What the operation returns.
 */
async function withRedis<T>(url: string, operation: (client: Redis) => Promise<T>): Promise<T> {
  const client = await connect(url);
  try {
    return await operation(client);
  } finally {
    await client.quit().catch(() => client.disconnect());
  }
}

/**
 * Reads a whole record body.
 *
 * @param body - The body.
 * @returns Its bytes.
 */
async function bytesOf(body: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Writes every key of a Redis database to an archive, one record per key with its serialized value
 * and its remaining time to live.
 *
 * @param url - The database.
 * @param archive - The archive being written.
 * @returns The number of keys.
 */
export async function snapshotRedis(url: string, archive: ArchiveWriter): Promise<number> {
  return withRedis(url, async (client) => {
    await archive.add({ type: "redis" });
    const seen = new Set<string>();
    let count = 0;
    for await (const keys of client.scanBufferStream({ count: 1000 }) as AsyncIterable<Buffer[]>) {
      for (const key of keys) {
        const name = key.toString("base64");
        if (seen.has(name)) {
          continue;
        }

        seen.add(name);
        const value = await client.dumpBuffer(key);
        const ttl = await client.pttl(key);
        if (value !== null && ttl !== -2) {
          await archive.add({ type: "key", key: name, ttl: Math.max(ttl, 0) }, [value]);
          count += 1;
        }
      }
    }
    return count;
  });
}

/**
 * Replaces the content of a Redis database by the keys of a snapshot, leaving the other databases
 * of the server as they are.
 *
 * @param url - The database.
 * @param records - The records of a Redis snapshot.
 * @returns The number of keys restored.
 */
export async function restoreRedis(url: string, records: AsyncIterable<ArchiveRecord>): Promise<number> {
  const iterator = records[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || first.value.header.type !== "redis") {
    throw new Error("not a Redis snapshot");
  }

  return withRedis(url, async (client) => {
    await client.flushdb();
    let count = 0;
    for (let record = await iterator.next(); !record.done; record = await iterator.next()) {
      const { header, body } = record.value;
      if (header.type !== "key" || typeof header.key !== "string" || typeof header.ttl !== "number") {
        throw new Error("not a Redis snapshot");
      }

      await client.restore(Buffer.from(header.key, "base64"), header.ttl, await bytesOf(body), "REPLACE");
      count += 1;
    }
    return count;
  });
}
