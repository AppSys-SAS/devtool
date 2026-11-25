import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { databaseEngine, type DatabaseTarget } from '../../src/engines.js'

const hasDocker = ((): boolean => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()
const START_TIMEOUT_MS = 180_000

/**
 * Runs a command in a container.
 * @param container - The container.
 * @param args - The command.
 * @returns Its standard output, trimmed.
 */
function exec (container: string, args: string[]): string {
  return execFileSync('docker', ['exec', container, ...args], { encoding: 'utf-8' }).trim()
}

/**
 * Starts a container and waits until a command succeeds in it.
 * @param image - The image.
 * @param env - Its environment variables.
 * @param ready - The command telling the container is ready.
 * @returns The name of the container.
 */
async function start (image: string, env: Record<string, string>, ready: string[]): Promise<string> {
  const name = `devtool-test-${randomUUID().slice(0, 8)}`
  execFileSync('docker', ['run', '-d', '--name', name, ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]), image], { stdio: 'ignore' })
  const deadline = Date.now() + START_TIMEOUT_MS
  for (let successes = 0; successes < 2;) {
    try {
      execFileSync('docker', ['exec', name, ...ready], { stdio: 'ignore' })
      successes += 1
    } catch {
      successes = 0
      if (Date.now() > deadline) {
        throw new Error(`${image} did not start`)
      }
    }
    await sleep(1000)
  }
  return name
}

/**
 * Collects a stream into one buffer.
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

describe.skipIf(!hasDocker)('native archives of real databases', () => {
  describe('postgres', () => {
    let target: DatabaseTarget
    const sql = (statement: string): string => exec(target.container, ['psql', '-U', 'postgres', '-d', 'shop', '-At', '-v', 'ON_ERROR_STOP=1', '-c', statement])
    const counts = (): string => sql('SELECT (SELECT count(*) FROM public.users) || \',\' || (SELECT count(*) FROM public."users extra") || \',\' || (SELECT count(*) FROM public."users TABLE DATA extra")')

    beforeAll(async () => {
      target = { container: await start('postgres:17', { POSTGRES_PASSWORD: 'secret' }, ['pg_isready', '-U', 'postgres', '-h', '127.0.0.1']), database: 'shop' }
      exec(target.container, ['psql', '-U', 'postgres', '-c', 'CREATE DATABASE shop'])
      sql('CREATE TABLE public.users (id int PRIMARY KEY); CREATE TABLE public."users extra" (id int PRIMARY KEY); CREATE TABLE public."users TABLE DATA extra" (id int PRIMARY KEY)')
      sql('INSERT INTO public.users VALUES (1), (2); INSERT INTO public."users extra" VALUES (1), (2), (3); INSERT INTO public."users TABLE DATA extra" VALUES (1)')
    }, START_TIMEOUT_MS)

    afterAll(() => {
      execFileSync('docker', ['rm', '-f', target.container], { stdio: 'ignore' })
    })

    it('restores only the requested table among tables whose names share words', async () => {
      const engine = databaseEngine('postgres')
      const archive = await bytesOf(engine.dumpNative(target))
      sql('DELETE FROM public.users; DELETE FROM public."users extra"; INSERT INTO public."users extra" VALUES (9)')

      await engine.restoreNative(target, () => Readable.from([archive]), ['public.users'])
      expect(counts()).toBe('2,1,1')
      await engine.restoreNative(target, () => Readable.from([archive]), ['public."users extra"'])
      expect(counts()).toBe('2,3,1')
    })

    it('refuses a table the archive holds no rows of, leaving its rows in place', async () => {
      const schemaOnly = execFileSync('docker', ['exec', target.container, 'pg_dump', '-U', 'postgres', '-Fc', '--schema-only', 'shop'])
      await expect(databaseEngine('postgres').restoreNative(target, () => Readable.from([schemaOnly]), ['public."users TABLE DATA extra"'])).rejects.toThrow('is not in the archive')
      expect(counts()).toBe('2,3,1')
    })

    it('finds a truncated archive incomplete before anything is restored', async () => {
      const archive = await bytesOf(databaseEngine('postgres').dumpNative(target))
      await expect(databaseEngine('postgres').checkNative(target, Readable.from([archive.subarray(0, archive.length / 2)]))).rejects.toThrow()
      await expect(databaseEngine('postgres').checkNative(target, Readable.from([archive]))).resolves.toBeUndefined()
    })
  })

  describe('mongodb', () => {
    let container: string
    const count = (database: string, collection: string): string => exec(container, ['mongosh', database, '--quiet', '--eval', `print(db.getCollection('${collection}').countDocuments())`])

    beforeAll(async () => {
      container = await start('mongo:7', {}, ['mongosh', '--quiet', '--eval', '1'])
      exec(container, ['mongosh', 'production', '--quiet', '--eval', 'db.users.insertMany([{ n: 1 }, { n: 2 }]); db.getCollection("fs.users").insertMany([{ n: 1 }, { n: 2 }, { n: 3 }])'])
    }, START_TIMEOUT_MS)

    afterAll(() => {
      execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' })
    })

    it('restores the requested collection of an archive of another database, and only it', async () => {
      const engine = databaseEngine('mongodb')
      const archive = await bytesOf(engine.dumpNative({ container, database: 'production' }))
      exec(container, ['mongosh', 'catalog', '--quiet', '--eval', 'db.getCollection("fs.users").insertOne({ local: true })'])

      await engine.checkNative({ container, database: 'catalog' }, Readable.from([archive]))
      await engine.restoreNative({ container, database: 'catalog' }, () => Readable.from([archive]), ['users'])
      expect([count('catalog', 'users'), count('catalog', 'fs.users'), count('production', 'users')]).toEqual(['2', '1', '2'])
    })

    it('finds an archive incomplete when its gzip stream is complete but its documents are not', async () => {
      const archive = gunzipSync(await bytesOf(databaseEngine('mongodb').dumpNative({ container, database: 'production' })))
      const incomplete = gzipSync(archive.subarray(0, Math.floor(archive.length / 2)))
      await expect(databaseEngine('mongodb').checkNative({ container, database: 'catalog' }, Readable.from([incomplete]))).rejects.toThrow('mongodump archive')
    })
  })
})
