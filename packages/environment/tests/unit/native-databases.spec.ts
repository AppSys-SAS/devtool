import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
const START_TIMEOUT_MS = 240_000
const TEST_TIMEOUT_MS = 120_000

let folder: string

/**
 * Runs a command in a container.
 * @param container - The container.
 * @param args - The command.
 * @returns Its standard output, trimmed.
 */
function exec (container: string, args: string[]): string {
  return execFileSync('docker', ['exec', container, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/**
 * Lists the temporary files of a container.
 * @param container - The container.
 * @returns Their names.
 */
function temporaryFiles (container: string): string {
  return exec(container, ['ls', '-A', '/tmp'])
}

/**
 * Removes a container and its anonymous volumes.
 * @param container - The container.
 */
function remove (container: string): void {
  execFileSync('docker', ['rm', '-fv', container], { stdio: 'ignore' })
}

/**
 * Starts a container and waits until a command succeeds in it; the container is removed when it
 * never does.
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
        remove(name)
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

/**
 * Writes an archive to a file.
 * @param archive - The archive.
 * @returns The path of the file.
 */
async function stored (archive: Buffer): Promise<string> {
  const archivePath = path.join(folder, randomUUID())
  await fs.writeFile(archivePath, archive)
  return archivePath
}

describe.skipIf(!hasDocker)('native archives of real databases', { timeout: TEST_TIMEOUT_MS }, () => {
  beforeAll(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-native-'))
  })

  afterAll(async () => {
    await fs.rm(folder, { recursive: true, force: true })
  })

  describe('postgres', () => {
    const engine = databaseEngine('postgres')
    let target: DatabaseTarget
    let archive: Buffer
    let temporary: string
    const sqlIn = (database: string, statement: string): string =>
      exec(target.container, ['psql', '-U', 'postgres', '-d', `dbname='${database}'`, '-At', '-v', 'ON_ERROR_STOP=1', '-c', statement])
    const sql = (statement: string): string => sqlIn('sales=2026', statement)
    const leftovers = (): string => sqlIn('postgres', `SELECT count(*) FROM pg_database WHERE datname LIKE 'adt\\_%'`)
    const state = (): string => sql(`SELECT concat_ws(',',
      (SELECT count(*) FROM public.users), (SELECT count(*) FROM public."users extra"), (SELECT count(*) FROM public."users TABLE DATA extra"),
      (SELECT count(*) FROM ONLY public.parent), (SELECT count(*) FROM public.child), (SELECT last_value FROM public.users_id_seq))`)

    beforeAll(async () => {
      target = { container: await start('postgres:17', { POSTGRES_PASSWORD: 'secret' }, ['pg_isready', '-U', 'postgres', '-h', '127.0.0.1']), database: 'sales=2026' }
      exec(target.container, ['createdb', '-U', 'postgres', 'sales=2026'])
      exec(target.container, ['createdb', '-U', 'postgres', 'other'])
      sqlIn('other', 'CREATE TABLE kept (id int); INSERT INTO kept VALUES (1), (2), (3)')
      sql(`CREATE TABLE public.users (id serial PRIMARY KEY, name text);
        CREATE TABLE public."users extra" (id int PRIMARY KEY);
        CREATE TABLE public."users TABLE DATA extra" (id int PRIMARY KEY);
        CREATE TABLE public.parent (id int PRIMARY KEY);
        CREATE TABLE public.child () INHERITS (public.parent);
        INSERT INTO public.users (name) VALUES ('a'), ('b');
        SELECT setval('public.users_id_seq', 100);
        INSERT INTO public."users extra" VALUES (1), (2), (3);
        INSERT INTO public."users TABLE DATA extra" VALUES (1);
        INSERT INTO public.parent VALUES (1), (2);
        INSERT INTO public.child VALUES (10), (11), (12);
        CREATE TABLE public.ev (id int GENERATED BY DEFAULT AS IDENTITY, at int, PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
        CREATE TABLE public.ev_2026 PARTITION OF public.ev FOR VALUES FROM (0) TO (1000);
        INSERT INTO public.ev (at) SELECT n FROM generate_series(1, 50) n`)
      archive = await bytesOf(engine.dumpNative(target))
      temporary = temporaryFiles(target.container)
    }, START_TIMEOUT_MS)

    afterAll(() => {
      remove(target.container)
    })

    it('lists the tables holding rows of a database whose name libpq would read as a connection string, partitioned tables left out', async () => {
      expect((await engine.listTables(target)).sort()).toEqual(['public."users TABLE DATA extra"', 'public."users extra"', 'public.child', 'public.ev_2026', 'public.parent', 'public.users'])
    })

    it('replaces the whole database, keeping the sequence values of the archive and the other databases', async () => {
      sql('DROP TABLE public.child; DELETE FROM public.users; CREATE TABLE public.stale (id int)')
      await engine.restoreNative(target, await stored(archive), null)

      expect(state()).toBe('2,3,1,2,3,100')
      expect(sql(`SELECT count(*) FROM pg_tables WHERE tablename = 'stale'`)).toBe('0')
      expect(sqlIn('other', 'SELECT count(*) FROM kept')).toBe('3')
      expect(leftovers()).toBe('0')
    })

    it.each([
      ['truncated', (whole: Buffer) => whole.subarray(0, Math.floor(whole.length / 2))],
      ['of another format', () => Buffer.from('-- a plain SQL dump\nCREATE TABLE t (id int);\n')],
      ['empty', () => Buffer.alloc(0)]
    ])('leaves the database as it was when the archive is %s, reporting the refusal of the engine alone', async (_case, broken) => {
      sql('DELETE FROM public.users WHERE id = 2')
      const refusal = await engine.restoreNative(target, await stored(broken(archive)), null).then(() => 'restored', (error: Error) => error.message)

      expect(refusal).toContain('pg_restore: error:')
      expect(refusal).not.toContain('NOTICE')
      expect(state()).toBe('1,3,1,2,3,100')
      expect(leftovers()).toBe('0')
      await engine.restoreNative(target, await stored(archive), null)
    })

    it('restores only the requested table among tables whose names share words', async () => {
      sql('DELETE FROM public.users; DELETE FROM public."users extra"; INSERT INTO public."users extra" VALUES (9)')
      await engine.restoreNative(target, await stored(archive), ['public.users'])
      expect(state()).toBe('2,1,1,2,3,3')

      await engine.restoreNative(target, await stored(archive), ['public."users extra"'])
      expect(state()).toBe('2,3,1,2,3,3')
      await engine.restoreNative(target, await stored(archive), null)
    })

    it('restores several tables named in another order than the archive lists them', async () => {
      sql('DELETE FROM public.users; DELETE FROM public."users extra"; DELETE FROM ONLY public.parent')
      await engine.restoreNative(target, await stored(archive), ['public.parent', 'public."users extra"', 'public.users'])

      expect(state()).toBe('2,3,1,2,3,3')
      await engine.restoreNative(target, await stored(archive), null)
    })

    it('restores a parent table without touching the rows of the tables inheriting from it, nor the sequences of other tables', async () => {
      sql('DELETE FROM ONLY public.parent; INSERT INTO public.parent VALUES (99)')
      await engine.restoreNative(target, await stored(archive), ['public.parent'])

      expect(state()).toBe('2,3,1,2,3,100')
    })

    it('refuses a table the archive holds no rows of, leaving its rows in place', async () => {
      const schemaOnly = execFileSync('docker', ['exec', target.container, 'pg_dump', '-U', 'postgres', '-Fc', '--schema-only', '-d', `dbname='sales=2026'`])
      await expect(engine.restoreNative(target, await stored(schemaOnly), ['public."users TABLE DATA extra"'])).rejects.toThrow('is not in the archive')

      expect(state()).toBe('2,3,1,2,3,100')
    })

    it('leaves every table as it was when the rows of one of them are refused', async () => {
      sql(`DELETE FROM public.users WHERE id = 2;
        ALTER TABLE public."users extra" ADD COLUMN required int NOT NULL DEFAULT 0;
        ALTER TABLE public."users extra" ALTER COLUMN required DROP DEFAULT`)
      await expect(engine.restoreNative(target, await stored(archive), ['public.users', 'public."users extra"'])).rejects.toThrow('violates not-null constraint')

      expect(state()).toBe('1,3,1,2,3,100')
      sql('ALTER TABLE public."users extra" DROP COLUMN required')
      await engine.restoreNative(target, await stored(archive), null)
    })

    it('sets the sequence of a partitioned table after the rows of a partition restored alone', async () => {
      sql(`TRUNCATE public.ev; SELECT setval(pg_get_serial_sequence('public.ev', 'id'), 1, false)`)
      await engine.restoreNative(target, await stored(archive), ['public.ev_2026'])

      expect(sql(`SELECT count(*) FROM public.ev`)).toBe('50')
      expect(sql(`SELECT nextval(pg_get_serial_sequence('public.ev', 'id'))`)).toBe('51')
    })

    it('creates a database that does not exist yet', async () => {
      const fresh = { container: target.container, database: `it's new` }
      await engine.restoreNative(fresh, await stored(archive), null)

      expect(await engine.listTables(fresh)).toContain('public.users')
      exec(target.container, ['dropdb', '-U', 'postgres', `it's new`])
    })

    it('leaves no temporary file in the container, after restores accepted and refused', () => {
      expect(temporaryFiles(target.container)).toBe(temporary)
    })
  })

  describe('mariadb', () => {
    const engine = databaseEngine('mariadb')
    let target: DatabaseTarget
    let archive: Buffer
    let temporary: string
    const sql = (statement: string, database = 'shop'): string => exec(target.container, ['mariadb', '-uroot', '-psecret', '-N', '-B', database, '-e', statement])
    const state = (): string => sql(`SELECT CONCAT_WS(',', (SELECT COUNT(*) FROM items), (SELECT COUNT(*) FROM item_names), (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = 'shop'))`)
    const tablesNamed = (name: string): string => sql(`SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'shop' AND TABLE_NAME = '${name}'`)

    beforeAll(async () => {
      const env = { MARIADB_ROOT_PASSWORD: 'secret', MARIADB_USER: 'app', MARIADB_PASSWORD: 'app-secret' }
      target = { container: await start('mariadb:11.4', env, ['mariadb', '-uroot', '-psecret', '-e', 'SELECT 1']), database: 'shop' }
      sql('CREATE DATABASE shop; CREATE DATABASE other; CREATE TABLE other.kept (id int); INSERT INTO other.kept VALUES (1), (2), (3)', 'mysql')
      sql(`CREATE TABLE items (id int PRIMARY KEY, name text);
        INSERT INTO items VALUES (1, 'a'), (2, 'b');
        CREATE VIEW item_names AS SELECT name FROM items;
        CREATE TRIGGER shop.items_insert BEFORE INSERT ON shop.items FOR EACH ROW SET NEW.name = NEW.name`)
      archive = await bytesOf(engine.dumpNative(target))
      temporary = temporaryFiles(target.container)
    }, START_TIMEOUT_MS)

    afterAll(() => {
      remove(target.container)
    })

    it('replaces the whole database, keeping the other databases', async () => {
      sql(`DROP TRIGGER items_insert; INSERT INTO items VALUES (3, 'c'); CREATE TABLE stale (id int)`)
      await engine.restoreNative(target, await stored(archive), null)

      expect(state()).toBe('2,2,1')
      expect(tablesNamed('stale')).toBe('0')
      expect(sql('SELECT COUNT(*) FROM other.kept')).toBe('3')
    })

    it('puts the database back as it was when the server refuses a statement of the dump', async () => {
      sql(`INSERT INTO items VALUES (3, 'c')`)
      const dump = gzipSync('-- MariaDB dump\nCREATE TABLE half (id int);\nINSERT INTO half VALUES (1);\nTHIS IS NOT SQL;\n')
      await expect(engine.restoreNative(target, await stored(dump), null)).rejects.toThrow('the database was put back as it was')

      expect(state()).toBe('3,3,1')
      expect(tablesNamed('half')).toBe('0')
      await engine.restoreNative(target, await stored(archive), null)
    })

    it('puts the database back as it was when the account of the container cannot be given it, and gives it once it can', async () => {
      sql(`INSERT INTO items VALUES (3, 'c'); RENAME USER app TO renamed`)
      await expect(engine.restoreNative(target, await stored(archive), null)).rejects.toThrow('the database was put back as it was')
      expect(state()).toBe('3,3,1')

      sql('RENAME USER renamed TO app')
      await engine.restoreNative(target, await stored(archive), null)
      expect(state()).toBe('2,2,1')
      expect(sql('SHOW GRANTS FOR app')).toContain('ON `shop`.*')
    })

    it('refuses a dump made with --databases, which would load into the database it names', async () => {
      const dump = gzipSync(execFileSync('docker', ['exec', target.container, 'mariadb-dump', '-uroot', '-psecret', '--databases', 'other']))
      await expect(engine.restoreNative(target, await stored(dump), null)).rejects.toThrow('the dump names its own database')

      expect(state()).toBe('2,2,1')
      expect(sql('SELECT COUNT(*) FROM other.kept')).toBe('3')
    })

    it('refuses a truncated archive without touching the database', async () => {
      await expect(engine.restoreNative(target, await stored(archive.subarray(0, archive.length - 20)), null)).rejects.toThrow()
      expect(state()).toBe('2,2,1')
    })

    it('removes a database that did not exist when its dump is refused', async () => {
      const fresh = { container: target.container, database: 'fresh`db' }
      await expect(engine.restoreNative(fresh, await stored(gzipSync('-- dump\nNOT SQL;\n')), null)).rejects.toThrow('was removed')
      expect(sql(`SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'fresh%'`, 'mysql')).toBe('0')

      await engine.restoreNative(fresh, await stored(gzipSync('-- dump\nCREATE TABLE items (id int);\n')), null)
      expect(await engine.listTables(fresh)).toEqual(['items'])
    })

    it('keeps the character set and collation of the database, restored or put back', async () => {
      const charset = (): string => sql(`SELECT CONCAT(DEFAULT_CHARACTER_SET_NAME, ',', DEFAULT_COLLATION_NAME) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'shop'`, 'mysql')
      const original = charset()
      sql('ALTER DATABASE shop CHARACTER SET latin1 COLLATE latin1_swedish_ci', 'mysql')

      await engine.restoreNative(target, await stored(archive), null)
      expect(charset()).toBe('latin1,latin1_swedish_ci')
      await expect(engine.restoreNative(target, await stored(gzipSync('-- dump\nNOT SQL;\n')), null)).rejects.toThrow('the database was put back as it was')
      expect(charset()).toBe('latin1,latin1_swedish_ci')
      expect(state()).toBe('2,2,1')

      const [characterSet, collation] = original.split(',')
      sql(`ALTER DATABASE shop CHARACTER SET ${characterSet} COLLATE ${collation}`, 'mysql')
    })

    it('refuses to replace a database it cannot save, which can be dropped to restore the archive', async () => {
      const broken = { container: target.container, database: 'broken' }
      const dump = await stored(gzipSync('-- dump\nCREATE TABLE items (id int);\n'))
      sql('CREATE DATABASE broken; CREATE TABLE broken.t (id int); CREATE VIEW broken.v AS SELECT id FROM broken.t; DROP TABLE broken.t', 'mysql')
      await expect(engine.restoreNative(broken, dump, null)).rejects.toThrow('the database could not be saved before its restore, so nothing was changed')
      expect(sql(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'broken'`, 'mysql')).toBe('v')

      sql('DROP DATABASE broken', 'mysql')
      await engine.restoreNative(broken, dump, null)
      expect(await engine.listTables(broken)).toEqual(['items'])
    })

    it('refuses a dump whose statements name another database, putting the database back as it was', async () => {
      const elsewhere = { container: target.container, database: 'elsewhere' }
      await engine.restoreNative(elsewhere, await stored(gzipSync('-- dump\nCREATE TABLE mine (id int);\nINSERT INTO mine VALUES (1);\n')), null)
      await expect(engine.restoreNative(elsewhere, await stored(archive), null)).rejects.toThrow('the database was put back as it was')

      expect(sql('SELECT COUNT(*) FROM mine', 'elsewhere')).toBe('1')
      expect(state()).toBe('2,2,1')
    })

    it('leaves no temporary file in the container, after restores accepted and refused', () => {
      expect(temporaryFiles(target.container)).toBe(temporary)
    })
  })

  describe('mongodb', () => {
    const engine = databaseEngine('mongodb')
    let container: string
    let archive: Buffer
    let temporary: string
    const mongo = (database: string, script: string): string => exec(container, ['mongosh', database, '--quiet', '--eval', script])
    const state = (database: string): string =>
      mongo(database, 'print(db.getCollectionNames().filter(name => !name.startsWith("system.")).sort().map(name => name + "=" + db.getCollection(name).countDocuments()).join(","))')

    beforeAll(async () => {
      container = await start('mongo:7', {}, ['mongosh', '--quiet', '--eval', '1'])
      mongo('production', `db.users.insertMany(Array.from({ length: 200 }, (_, n) => ({ n, text: "x".repeat(200) })));
        db.getCollection("fs.users").insertMany([{ n: 1 }, { n: 2 }, { n: 3 }]);
        db.createCollection("metrics", { timeseries: { timeField: "at" } });
        db.metrics.insertMany([{ at: new Date(), v: 1 }, { at: new Date(), v: 2 }]);
        db.createView("names", "users", [])`)
      mongo('other', 'db.kept.insertMany([{ n: 1 }, { n: 2 }])')
      archive = await bytesOf(engine.dumpNative({ container, database: 'production' }))
      temporary = temporaryFiles(container)
    }, START_TIMEOUT_MS)

    afterAll(() => {
      remove(container)
    })

    it('replaces the whole database by an archive of another database, time-series collections and views included', async () => {
      mongo('catalog', 'db.stale.insertOne({ n: 1 }); db.users.insertOne({ local: true })')
      await engine.restoreNative({ container, database: 'catalog' }, await stored(archive), null)

      expect(state('catalog')).toBe('fs.users=3,metrics=2,names=200,users=200')
      expect(state('production')).toBe('fs.users=3,metrics=2,names=200,users=200')
      expect(state('other')).toBe('kept=2')
      expect(mongo('admin', 'print(db.adminCommand({ listDatabases: 1 }).databases.filter(database => database.name.startsWith("adt_")).length)')).toBe('0')
    })

    it('restores the requested collections only, a time-series one included', async () => {
      mongo('catalog', 'db.users.deleteMany({}); db.metrics.drop(); db.getCollection("fs.users").insertOne({ local: true })')
      await engine.restoreNative({ container, database: 'catalog' }, await stored(archive), ['users', 'metrics'])

      expect(state('catalog')).toBe('fs.users=4,metrics=2,names=200,users=200')
      await engine.restoreNative({ container, database: 'catalog' }, await stored(archive), null)
    })

    it.each([
      ['incomplete inside a complete gzip stream', (raw: Buffer) => raw.subarray(0, Math.floor(raw.length / 2))],
      ['altered, its checksums no longer matching', (raw: Buffer) => {
        const altered = Buffer.from(raw)
        altered[altered.indexOf('xxxxxxxxxxxxxxxx') + 8] = 'y'.charCodeAt(0)
        return altered
      }]
    ])('leaves the database as it was when the archive is %s', async (_case, broken) => {
      mongo('catalog', 'db.users.deleteMany({ n: { $gte: 100 } })')
      await expect(engine.restoreNative({ container, database: 'catalog' }, await stored(gzipSync(broken(gunzipSync(archive)))), null)).rejects.toThrow()

      expect(state('catalog')).toBe('fs.users=3,metrics=2,names=100,users=100')
      expect(mongo('admin', 'print(db.adminCommand({ listDatabases: 1 }).databases.filter(database => database.name.startsWith("adt_")).length)')).toBe('0')
      await engine.restoreNative({ container, database: 'catalog' }, await stored(archive), null)
    })

    it('refuses an archive of several databases, leaving the database as it was', async () => {
      const several = execFileSync('docker', ['exec', container, 'mongodump', '--quiet', '--archive', '--gzip'], { maxBuffer: 256 * 1024 * 1024 })
      await expect(engine.restoreNative({ container, database: 'catalog' }, await stored(several), null)).rejects.toThrow('the archive holds several databases')

      expect(state('catalog')).toBe('fs.users=3,metrics=2,names=200,users=200')
    })

    it('refuses to dump a database without collection, which would give an empty archive', async () => {
      await expect(bytesOf(engine.dumpNative({ container, database: 'absent' }))).rejects.toThrow('the database absent has no collection')
    })

    it('leaves no temporary file in the container, after restores accepted and refused', () => {
      expect(temporaryFiles(container)).toBe(temporary)
    })
  })

  describe('mongodb with root credentials', () => {
    const engine = databaseEngine('mongodb')
    const credentials = ['--username', 'root', '--password', 'secret', '--authenticationDatabase', 'admin']
    let container: string
    const mongo = (database: string, script: string): string => exec(container, ['mongosh', database, '--quiet', ...credentials, '--eval', script])
    const state = (): string => mongo('catalog', 'print(db.getCollectionNames().sort().map(name => name + "=" + db.getCollection(name).countDocuments()).join(","))')

    beforeAll(async () => {
      const env = { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: 'secret' }
      container = await start('mongo:7', env, ['mongosh', '--quiet', ...credentials, '--eval', '1'])
    }, START_TIMEOUT_MS)

    afterAll(() => {
      remove(container)
    })

    it('dumps a database and restores it, whole then one collection', async () => {
      mongo('production', 'db.users.insertMany([{ n: 1 }, { n: 2 }]); db.orders.insertOne({ n: 1 })')
      const archive = await stored(await bytesOf(engine.dumpNative({ container, database: 'production' })))
      mongo('catalog', 'db.stale.insertOne({ n: 1 })')
      await engine.restoreNative({ container, database: 'catalog' }, archive, null)
      expect(state()).toBe('orders=1,users=2')

      mongo('catalog', 'db.users.deleteMany({}); db.orders.deleteMany({})')
      await engine.restoreNative({ container, database: 'catalog' }, archive, ['users'])
      expect(state()).toBe('orders=0,users=2')
      expect(mongo('admin', 'print(db.adminCommand({ listDatabases: 1 }).databases.filter(database => database.name.startsWith("adt_")).length)')).toBe('0')
      await expect(bytesOf(engine.dumpNative({ container, database: 'absent' }))).rejects.toThrow('the database absent has no collection')
    })
  })
})
