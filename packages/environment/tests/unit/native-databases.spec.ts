import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { databaseEngine, type DatabaseTarget, stopRun } from '../../src/engines.js'

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
const COMMAND_TIMEOUT_MS = 60_000

let folder: string

/**
 * Runs a docker command, killed when it does not end in time.
 * @param args - The arguments of docker.
 * @param timeout - How long it may run, in milliseconds.
 * @returns Its standard output.
 */
function docker (args: string[], timeout = COMMAND_TIMEOUT_MS): Buffer {
  return execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 256 * 1024 * 1024 })
}

/**
 * Runs a command in a container.
 * @param container - The container.
 * @param args - The command.
 * @returns Its standard output, trimmed.
 */
function exec (container: string, args: string[]): string {
  return docker(['exec', container, ...args]).toString('utf-8').trim()
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
  docker(['rm', '-fv', container])
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
  const deadline = Date.now() + START_TIMEOUT_MS
  docker(['run', '-d', '--name', name, ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]), image], START_TIMEOUT_MS)
  for (let successes = 0; successes < 2;) {
    try {
      docker(['exec', name, ...ready], Math.max(1000, deadline - Date.now()))
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
      const env = { POSTGRES_PASSWORD: 'secret', POSTGRES_INITDB_ARGS: '--locale-provider=icu --icu-locale=en-US' }
      target = { container: await start('postgres:17', env, ['pg_isready', '-U', 'postgres', '-h', '127.0.0.1']), database: 'sales=2026' }
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
        INSERT INTO public.ev (at) SELECT n FROM generate_series(1, 50) n;
        CREATE ROLE reader;
        CREATE ROLE departed;
        GRANT SELECT ON public.users TO reader, departed`)
      archive = await bytesOf(engine.dumpNative(target))
      sql('REVOKE ALL ON public.users FROM departed; DROP ROLE departed')
      temporary = temporaryFiles(target.container)
    }, START_TIMEOUT_MS)

    afterAll(() => {
      remove(target.container)
    })

    it('stops inside the container a dump its signal cancels while it waits on a lock, the other sessions of the server untouched', async () => {
      const dumps = (): string => sqlIn('postgres', `SELECT count(*) FROM pg_stat_activity WHERE application_name = 'pg_dump'`)
      const locks = (): string => sql(`SELECT count(*) FROM pg_locks WHERE mode = 'AccessExclusiveLock' AND relation = 'public.users'::regclass`)
      const zombies = (): string => exec(target.container, ['sh', '-c', `grep -l '^State:[[:space:]]*Z' /proc/[0-9]*/status 2>/dev/null | wc -l`])
      docker(['exec', '-d', target.container, 'psql', '-U', 'postgres', '-d', `dbname='sales=2026'`, '-c', 'BEGIN; LOCK TABLE public.users IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(60)'])
      try {
        await vi.waitFor(() => expect(locks()).toBe('1'), { timeout: 10_000 })
        const cancel = new AbortController()
        const dump = bytesOf(engine.dumpTable(target, 'public.users', cancel.signal))
        await vi.waitFor(() => expect(dumps()).toBe('1'), { timeout: 10_000 })
        cancel.abort(new Error('cancelled'))

        await expect(dump).rejects.toThrow()
        await vi.waitFor(() => expect(dumps()).toBe('0'), { timeout: 5000 })
        expect(locks()).toBe('1')
        await vi.waitFor(() => expect(zombies()).toBe('0'), { timeout: 5000 })
      } finally {
        sqlIn('postgres', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep%' AND pid <> pg_backend_pid()`)
      }
    })

    it('stops a run whose shell keeps starting commands, each process reaped by its own parent', async () => {
      const marked = (run: string): string => exec(target.container, ['sh', '-c', `for proc in /proc/[0-9]*; do tr '\\0' '\\n' 2>/dev/null < "$proc/environ" | grep -qx "ADT_RUN=$1" && echo; done | wc -l`, 'sh', run])
      const states = (state: string): string => exec(target.container, ['sh', '-c', `grep -l '^State:[[:space:]]*${state}' /proc/[0-9]*/status 2>/dev/null | wc -l`])
      const survivors = (): string => sqlIn('postgres', `SELECT count(*) FROM pg_stat_activity WHERE application_name = 'survivor'`)
      const idle = randomUUID()
      docker(['exec', '-d', '-e', `ADT_RUN=${idle}`, target.container, 'sh', '-c', 'for i in $(seq 300); do sleep 600 & done; wait'])
      docker(['exec', '-d', '-e', 'PGAPPNAME=survivor', target.container, 'psql', '-U', 'postgres', '-c', 'SELECT pg_sleep(600)'])
      try {
        await vi.waitFor(() => expect(survivors()).toBe('1'), { timeout: 10_000 })
        for (let offset = 0; offset <= 300; offset += 25) {
          const run = randomUUID()
          docker(['exec', '-d', '-e', `ADT_RUN=${run}`, target.container, 'sh', '-c', 'x=$(sleep 0.3); sleep 60'])
          await sleep(offset)
          await stopRun(target.container, run)

          expect(marked(run)).toBe('0')
          expect(survivors()).toBe('1')
          await vi.waitFor(() => expect(states('[TZ]')).toBe('0'), { timeout: 3000 })
        }
      } finally {
        await stopRun(target.container, idle)
        sqlIn('postgres', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'survivor'`)
      }
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

    it('keeps the privileges the archive grants to roles of the server, skipping roles the server lacks', async () => {
      sql('REVOKE ALL ON public.users FROM reader')
      expect(await engine.restoreNative(target, await stored(archive), null)).toBeNull()

      expect(sql(`SELECT has_table_privilege('reader', 'public.users', 'SELECT')`)).toBe('t')
      expect(state()).toBe('2,3,1,2,3,100')
    })

    it('keeps the encoding, locale, libc provider and owner of the database it replaces, on a server whose default provider is ICU', async () => {
      const kept = { container: target.container, database: 'kept' }
      sqlIn('postgres', `CREATE DATABASE kept TEMPLATE template0 ENCODING 'LATIN1' LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C' OWNER reader`)
      await engine.restoreNative(kept, await stored(archive), null)

      expect(sqlIn('postgres', `SELECT concat_ws(',', pg_encoding_to_char(encoding), datcollate, pg_get_userbyid(datdba), datlocprovider) FROM pg_database WHERE datname = 'kept'`)).toBe('LATIN1,C,reader,c')
      expect(await engine.listTables(kept)).toContain('public.users')
      sqlIn('postgres', 'DROP DATABASE kept')
    })

    it('keeps the ICU locale provider and locale of the database it replaces', async () => {
      const icu = { container: target.container, database: 'icu' }
      sqlIn('postgres', `CREATE DATABASE icu TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'fr-FR' LOCALE 'C'`)
      await engine.restoreNative(icu, await stored(archive), null)

      expect(sqlIn('postgres', `SELECT concat_ws(',', datlocprovider, datlocale) FROM pg_database WHERE datname = 'icu'`)).toBe('i,fr-FR')
      sqlIn('postgres', 'DROP DATABASE icu')
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
      const schemaOnly = docker(['exec', target.container, 'pg_dump', '-U', 'postgres', '-Fc', '--schema-only', '-d', `dbname='sales=2026'`])
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
      const dump = gzipSync(docker(['exec', target.container, 'mariadb-dump', '-uroot', '-psecret', '--databases', 'other']))
      await expect(engine.restoreNative(target, await stored(dump), null)).rejects.toThrow('the dump names its own database')

      expect(state()).toBe('2,2,1')
      expect(sql('SELECT COUNT(*) FROM other.kept')).toBe('3')
    })

    it.each([
      ['run a command of the container', '\\! touch /tmp/adt-sandbox-proof'],
      ['read a file of the container', `LOAD DATA LOCAL INFILE '/etc/hostname' INTO TABLE half;`]
    ])('puts the database back when the dump tries to %s, which the sandbox mode of the client refuses', async (_case, statement) => {
      const dump = gzipSync(`-- MariaDB dump\nCREATE TABLE half (line text);\n${statement}\n`)
      await expect(engine.restoreNative(target, await stored(dump), null)).rejects.toThrow('the database was put back as it was')

      expect(state()).toBe('2,2,1')
      expect(tablesNamed('half')).toBe('0')
      expect(exec(target.container, ['sh', '-c', 'ls /tmp/adt-sandbox-proof 2> /dev/null || echo absent'])).toBe('absent')
    })

    it('grants the account of the container a database whose name holds wildcards of privilege targets as that name only', async () => {
      await engine.restoreNative({ container: target.container, database: 'under_score' }, await stored(gzipSync('-- dump\nCREATE TABLE t (id int);\n')), null)

      expect(sql('SHOW GRANTS FOR app', 'mysql')).toContain('ON `under\\\\_score`.*')
    })

    it('dumps and restores a database named like a client option as that database only', async () => {
      const named = { container: target.container, database: '--all-databases' }
      await engine.restoreNative(named, await stored(gzipSync('-- dump\nCREATE TABLE mine (id int);\n')), null)
      const dump = gunzipSync(await bytesOf(engine.dumpNative(named))).toString('utf-8')

      expect(await engine.listTables(named)).toEqual(['mine'])
      expect(dump).toContain('CREATE TABLE `mine`')
      expect(dump).not.toContain('CREATE TABLE `items`')
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
      const several = docker(['exec', container, 'mongodump', '--quiet', '--archive', '--gzip'])
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
