import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendContext, EnvironmentBackend } from '../../src/backends/backend.js'
import { databaseEngine, splitPostgresName } from '../../src/engines.js'
import { Environment, type EnvironmentItem } from '../../src/environment.js'

let folder: string

/**
 * Reads the arguments the fake docker command was called with.
 * @returns The arguments of each call.
 */
async function dockerCalls (): Promise<string[][]> {
  const log = await fs.readFile(path.join(folder, 'calls'), 'utf-8').catch(() => '')
  return log.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as string[])
}

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-engines-'))
  const docker = path.join(folder, 'docker')
  await fs.writeFile(docker, `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(path.join(folder, 'calls'))}, JSON.stringify(process.argv.slice(2)) + '\\n')
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
`, { mode: 0o755 })
  vi.stubEnv('PATH', `${folder}${path.delimiter}${process.env.PATH ?? ''}`)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fs.rm(folder, { recursive: true, force: true })
})

describe('splitPostgresName', () => {
  it('splits and unquotes a schema.table name', () => {
    expect(splitPostgresName('public.users')).toEqual({ schema: 'public', table: 'users' })
    expect(splitPostgresName('"My Schema"."Order.Lines"')).toEqual({ schema: 'My Schema', table: 'Order.Lines' })
    expect(splitPostgresName('public."say ""hi"""')).toEqual({ schema: 'public', table: 'say "hi"' })
    expect(() => splitPostgresName('users')).toThrow('not a schema.table name: users')
  })
})

/**
 * Builds a BSON document of string and boolean fields.
 * @param fields - The fields.
 * @returns The document.
 */
function bsonDocument (fields: Record<string, string | boolean>): Buffer {
  const elements = Object.entries(fields).map(([name, value]) => {
    if (typeof value === 'boolean') {
      return Buffer.concat([Buffer.from([0x08]), Buffer.from(`${name}\0`), Buffer.from([value ? 1 : 0])])
    }
    const text = Buffer.from(`${value}\0`)
    const length = Buffer.alloc(4)
    length.writeInt32LE(text.length)
    return Buffer.concat([Buffer.from([0x02]), Buffer.from(`${name}\0`), length, text])
  })
  const size = Buffer.alloc(4)
  size.writeInt32LE(4 + elements.reduce((total, element) => total + element.length, 0) + 1)
  return Buffer.concat([size, ...elements, Buffer.from([0])])
}

const TERMINATOR = Buffer.from([0xff, 0xff, 0xff, 0xff])

/**
 * Builds the uncompressed beginning of a `mongodump --archive` archive listing collections of a database.
 * @param db - The database the collections were dumped from.
 * @param collections - The collections.
 * @returns The magic number, the header and the list of collections.
 */
function mongodumpPreludeBytes (db: string, collections: string[]): Buffer {
  return Buffer.concat([
    Buffer.from([0x6d, 0xe2, 0x99, 0x81]),
    bsonDocument({ version: '0.1', server_version: '7.0.0' }),
    ...collections.map(collection => bsonDocument({ db, collection, metadata: '{}' })),
    TERMINATOR
  ])
}

/**
 * Builds the beginning of a `mongodump --archive --gzip` archive listing collections of a database.
 * @param db - The database the collections were dumped from.
 * @param collections - The collections.
 * @returns The gzip-compressed prelude.
 */
function mongodumpPrelude (db: string, collections: string[]): Buffer {
  return gzipSync(mongodumpPreludeBytes(db, collections))
}

/**
 * Builds a whole `mongodump --archive --gzip` archive, one document per collection.
 * @param db - The database the collections were dumped from.
 * @param collections - The collections.
 * @returns The gzip-compressed archive.
 */
function mongodumpArchive (db: string, collections: string[]): Buffer {
  return gzipSync(Buffer.concat([
    mongodumpPreludeBytes(db, collections),
    ...collections.flatMap(collection => [
      bsonDocument({ db, collection, EOF: false }), bsonDocument({ value: collection }), TERMINATOR,
      bsonDocument({ db, collection, EOF: true }), TERMINATOR
    ])
  ]))
}

describe('database targets', () => {
  it('passes the database of the item to the container, and nothing for the default one of the image', async () => {
    const mongodb = databaseEngine('mongodb')
    const archive = (): Readable => Readable.from([mongodumpPrelude('production', ['users', 'fs.users'])])
    await mongodb.restoreNative({ container: 'mongo', database: 'catalog' }, archive, ['users'])
    await mongodb.restoreNative({ container: 'mongo', database: null }, archive, null)

    const [named, unnamed] = await dockerCalls()
    expect(named.slice(0, 4)).toEqual(['exec', '-i', '-e', 'ADT_DATABASE=catalog'])
    expect(named[4]).toBe('mongo')
    expect(named[7]).toContain('mongorestore --quiet --archive --gzip --drop')
    expect(named.slice(-2)).toEqual(['--nsInclude', 'production.users'])
    expect(unnamed.slice(0, 3)).toEqual(['exec', '-i', 'mongo'])
    expect(unnamed[unnamed.length - 1]).toBe('sh')
  })

  it('accepts a whole mongodb archive and refuses a complete gzip stream holding an incomplete one', async () => {
    const check = async (archive: Buffer): Promise<void> => databaseEngine('mongodb').checkNative({ container: 'mongo', database: null }, Readable.from([archive]))
    await expect(check(mongodumpArchive('production', ['users', 'orders']))).resolves.toBeUndefined()
    await expect(check(gzipSync(Buffer.from([0x6d, 0xe2, 0x99, 0x81])))).rejects.toThrow('no complete list of collections')
    await expect(check(gzipSync(Buffer.concat([Buffer.from([0x6d, 0xe2, 0x99, 0x81]), TERMINATOR])))).rejects.toThrow('no header')
    await expect(check(mongodumpPrelude('production', ['users']))).rejects.toThrow('production.users never ends')
    const whole = gunzipSync(mongodumpArchive('production', ['users']))
    await expect(check(gzipSync(whole.subarray(0, whole.length - 10)))).rejects.toThrow('not a mongodump archive: it ends in the middle of a document')
    expect(await dockerCalls()).toEqual([])
  })

  it('refuses a mongodb archive whose list of collections is corrupted, before running anything', async () => {
    const header = Buffer.concat([Buffer.from([0x6d, 0xe2, 0x99, 0x81]), bsonDocument({ version: '0.1' })])
    const zeroSize = gzipSync(Buffer.concat([header, Buffer.alloc(4)]))
    const badLength = bsonDocument({ db: 'production', collection: 'users' })
    badLength.writeInt32LE(1_000_000, 4 + 1 + 'db'.length + 1)
    const outOfDocument = gzipSync(Buffer.concat([header, badLength]))
    const smallOverrun = bsonDocument({ db: 'production', collection: 'users' })
    smallOverrun.writeInt32LE(smallOverrun.length - 8 - 2, 4 + 1 + 'db'.length + 1)
    const overrunByFewBytes = gzipSync(Buffer.concat([header, smallOverrun]))
    for (const archive of [zeroSize, outOfDocument, overrunByFewBytes]) {
      await expect(databaseEngine('mongodb').restoreNative({ container: 'mongo', database: 'catalog' }, () => Readable.from([archive]), ['users'])).rejects.toThrow('not a mongodump archive')
    }
    expect(await dockerCalls()).toEqual([])
  })

  it('refuses to restore mongodb collections the archive does not hold, before running anything', async () => {
    const archive = (): Readable => Readable.from([mongodumpPrelude('production', ['users'])])
    await expect(databaseEngine('mongodb').restoreNative({ container: 'mongo', database: 'catalog' }, archive, ['users', 'orders'])).rejects.toThrow('not in the archive: orders')
    expect(await dockerCalls()).toEqual([])
  })

  it('restores some postgres tables from a native archive as rows only, each schema and table paired', async () => {
    await databaseEngine('postgres').restoreNative({ container: 'pg', database: null }, () => Readable.from([Buffer.from('archive')]), ['public.users', '"Sales"."Orders"'])

    const [call] = await dockerCalls()
    expect(call.slice(call.indexOf('sh', 4) + 1)).toEqual([
      'DELETE FROM public.users; DELETE FROM "Sales"."Orders";',
      'public', 'users',
      'Sales', 'Orders'
    ])
    const script = call.find(arg => arg.includes('pg_restore'))
    expect(script).toContain('is not in the archive')
    expect(script).toContain('pg_restore -l -n "$1" -t "$2"')
    expect(script).toContain(`grep -E '^[0-9]+; [0-9]+ [0-9]+ TABLE DATA '`)
    expect(script).toContain('pg_restore --data-only -L')
  })

  it('tells the native archives of each engine from those of the others', () => {
    const heads = {
      postgres: Buffer.from('PGDMP\u0001\u000e'),
      mongodb: Buffer.from([0x6d, 0xe2, 0x99, 0x81, 0x00]),
      mariadb: Buffer.from('/*M!999999\\- enable the sandbox mode */\n-- MariaDB dump')
    }
    for (const engine of ['postgres', 'mongodb', 'mariadb'] as const) {
      for (const [other, head] of Object.entries(heads)) {
        expect(databaseEngine(engine).isNativeHead(head), `${engine} reading a ${other} archive`).toBe(engine === other)
      }
    }
    expect(databaseEngine('mariadb').isNativeHead(Buffer.from('-- MySQL dump 10.13'))).toBe(true)
    expect([databaseEngine('postgres').nativeGzipped, databaseEngine('mongodb').nativeGzipped, databaseEngine('mariadb').nativeGzipped]).toEqual([false, true, true])
  })

  it('refuses to restore some tables of a native mariadb archive', async () => {
    await expect(databaseEngine('mariadb').restoreNative({ container: 'db', database: null }, () => Readable.from([]), ['users'])).rejects.toThrow('restores the whole database only')
    expect(await dockerCalls()).toEqual([])
  })

  it('leaves a mariadb database untouched when its native archive is truncated', async () => {
    const archive = gzipSync(`-- MariaDB dump\n${'INSERT INTO t VALUES (1);\n'.repeat(1000)}`)
    const item: EnvironmentItem = { kind: 'database', path: 'api/db.sql.gz', backend: 'team', encryption: null, groups: { pull: null, push: null }, engine: 'mariadb', container: 'db', database: 'shop', format: 'native' }
    const backend: EnvironmentBackend = {
      list: async () => [],
      download: async () => Readable.from([archive.subarray(0, archive.length - 40)]),
      upload: async () => undefined,
      remove: async () => undefined,
      close: async () => undefined
    }
    const context: BackendContext = { resolve: async text => text, askSecret: async () => '', cacheDir: folder, configFolder: folder, auth: null }
    const environment = new Environment(new Map([['team', backend]]), { folder, backends: [], defaultBackend: 'team', items: [item], configFiles: [], autoPulls: [], s3: null }, context)

    await expect(environment.pull({ item, tables: null })).rejects.toThrow('api/db.sql.gz is not a complete native mariadb archive')
    expect(await dockerCalls()).toEqual([])
  })

  it.each([
    ['postgres', Buffer.from('-- plain SQL dump')],
    ['mongodb', gzipSync('-- MariaDB dump 10.19')],
    ['mariadb', gzipSync(Buffer.from([0x6d, 0xe2, 0x99, 0x81, 0x00, 0x01]))]
  ] as const)('leaves a %s database untouched when the pulled file is not one of its native archives', async (engine, content) => {
    const item: EnvironmentItem = { kind: 'database', path: 'api/db.dump', backend: 'team', encryption: null, groups: { pull: null, push: null }, engine, container: 'db', database: 'shop', format: 'native' }
    const backend: EnvironmentBackend = {
      list: async () => [],
      download: async () => Readable.from([content]),
      upload: async () => undefined,
      remove: async () => undefined,
      close: async () => undefined
    }
    const context: BackendContext = { resolve: async text => text, askSecret: async () => '', cacheDir: folder, configFolder: folder, auth: null }
    const environment = new Environment(new Map([['team', backend]]), { folder, backends: [], defaultBackend: 'team', items: [item], configFiles: [], autoPulls: [], s3: null }, context)

    await expect(environment.pull({ item, tables: null })).rejects.toThrow(`api/db.dump is not a native ${engine} archive`)
    expect(await dockerCalls()).toEqual([])
  })

  it.each([
    ['a list of collections whose data never comes', mongodumpPrelude('production', ['users'])],
    ['no header', gzipSync(Buffer.concat([Buffer.from([0x6d, 0xe2, 0x99, 0x81]), TERMINATOR]))]
  ])('leaves a mongodb database untouched when the pulled archive is complete gzip but a mongodump with %s', async (_case, content) => {
    const item: EnvironmentItem = { kind: 'database', path: 'api/db.archive.gz', backend: 'team', encryption: null, groups: { pull: null, push: null }, engine: 'mongodb', container: 'mongo', database: 'shop', format: 'native' }
    const backend: EnvironmentBackend = {
      list: async () => [],
      download: async () => Readable.from([content]),
      upload: async () => undefined,
      remove: async () => undefined,
      close: async () => undefined
    }
    const context: BackendContext = { resolve: async text => text, askSecret: async () => '', cacheDir: folder, configFolder: folder, auth: null }
    const environment = new Environment(new Map([['team', backend]]), { folder, backends: [], defaultBackend: 'team', items: [item], configFiles: [], autoPulls: [], s3: null }, context)

    await expect(environment.pull({ item, tables: null })).rejects.toThrow('api/db.archive.gz is not a complete native mongodb archive')
    expect(await dockerCalls()).toEqual([])
  })
})
