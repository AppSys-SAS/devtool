import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertDatabaseLessDump, databaseEngine, splitPostgresName } from '../../src/engines.js'

const MAGIC = Buffer.from([0x6d, 0xe2, 0x99, 0x81])
const TERMINATOR = Buffer.from([0xff, 0xff, 0xff, 0xff])

let folder: string

/**
 * Reads the arguments the fake docker command was called with.
 * @returns The arguments of each call.
 */
async function dockerCalls (): Promise<string[][]> {
  const log = await fs.readFile(path.join(folder, 'calls'), 'utf-8').catch(() => '')
  return log.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as string[])
}

/**
 * Gives the arguments a call passed to its script, after the script itself.
 * @param call - The arguments of the call.
 * @returns The arguments of the script.
 */
function scriptArguments (call: string[]): string[] {
  return call.slice(call.indexOf('-c') + 3)
}

/**
 * Gives the script a call ran.
 * @param call - The arguments of the call.
 * @returns The script.
 */
function scriptOf (call: string[]): string {
  return call[call.indexOf('-c') + 1]
}

/**
 * Builds a BSON document of string fields.
 * @param fields - The fields.
 * @returns The document.
 */
function bsonDocument (fields: Record<string, string>): Buffer {
  const elements = Object.entries(fields).map(([name, value]) => {
    const text = Buffer.from(`${value}\0`)
    const length = Buffer.alloc(4)
    length.writeInt32LE(text.length)
    return Buffer.concat([Buffer.from([0x02]), Buffer.from(`${name}\0`), length, text])
  })
  const size = Buffer.alloc(4)
  size.writeInt32LE(4 + elements.reduce((total, element) => total + element.length, 0) + 1)
  return Buffer.concat([size, ...elements, Buffer.from([0])])
}

/**
 * Builds the beginning of a `mongodump --archive --gzip` archive listing collections.
 * @param collections - The collections, as `[database, collection]` pairs.
 * @returns The gzip-compressed prelude.
 */
function mongodumpPrelude (collections: [string, string][]): Buffer {
  return gzipSync(Buffer.concat([
    MAGIC,
    bsonDocument({ version: '0.1', server_version: '7.0.0' }),
    ...collections.map(([db, collection]) => bsonDocument({ db, collection, metadata: '{}' })),
    TERMINATOR
  ]))
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

/** What a script run outside its container did. */
interface ScriptRun {
  code: number | null
  stdout: string
  stderr: string
  /** Each call of a fake command, as its name followed by its arguments. */
  calls: string[]
  /** The files the script left in its temporary folder. */
  leftovers: string[]
}

/**
 * Runs the script of a docker call outside any container, with fake commands in place of the tools
 * of the engine, and temporary files made in a folder of their own; the database the call names is
 * given to the script as in the container.
 * @param call - The arguments of the docker call.
 * @param input - The standard input of the script.
 * @param commands - The shell body of each fake command, by name, run after the call is logged.
 * @param env - The environment variables of the container.
 * @returns What the script did.
 */
async function runScript (call: string[], input: string, commands: Record<string, string>, env: Record<string, string> = {}): Promise<ScriptRun> {
  const bin = await fs.mkdtemp(path.join(folder, 'bin-'))
  const temporary = await fs.mkdtemp(path.join(folder, 'tmp-'))
  const log = path.join(bin, 'calls')
  for (const [name, body] of Object.entries(commands)) {
    await fs.writeFile(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 })
  }
  await fs.writeFile(path.join(bin, 'mktemp'), `#!/bin/sh
n=0
while [ -e "$TMPDIR/tmp.$n" ]; do n=$((n + 1)); done
if [ "$1" = -d ]; then mkdir "$TMPDIR/tmp.$n"; else : > "$TMPDIR/tmp.$n"; fi
echo "$TMPDIR/tmp.$n"
`, { mode: 0o755 })
  const database = call.find(arg => arg.startsWith('ADT_DATABASE='))?.slice('ADT_DATABASE='.length)
  const run = spawnSync('sh', ['-c', scriptOf(call), 'sh', ...scriptArguments(call)], {
    input,
    encoding: 'utf-8',
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, TMPDIR: temporary, ...(database === undefined ? {} : { ADT_DATABASE: database }), ...env }
  })
  const calls = await fs.readFile(log, 'utf-8').then(text => text.split('\n').filter(line => line !== ''), () => [])
  return { code: run.status, stdout: run.stdout, stderr: run.stderr, calls, leftovers: await fs.readdir(temporary) }
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

describe('mongodb native archives', () => {
  const mongodb = databaseEngine('mongodb')

  it('passes the database of the item to the container, and nothing for the one of the image', async () => {
    const archive = await stored(mongodumpPrelude([['production', 'users']]))
    await mongodb.restoreNative({ container: 'mongo', database: 'catalog' }, archive, ['users'])
    await mongodb.restoreNative({ container: 'mongo', database: null }, archive, ['users'])

    const calls = await dockerCalls()
    expect(calls[0].slice(0, 5)).toEqual(['exec', '-i', '-e', 'ADT_DATABASE=catalog', 'mongo'])
    expect(calls[1].slice(0, 3)).toEqual(['exec', '-i', 'mongo'])
  })

  it('restores the exact collections asked into a database of its own first, then into the database, in one run of the container', async () => {
    const prelude = mongodumpPrelude([['production', 'users'], ['production', 'fs.users'], ['production', 'orders']])
    await mongodb.restoreNative({ container: 'mongo', database: 'catalog' }, await stored(prelude), ['users', 'orders'])

    const [call, ...others] = await dockerCalls()
    expect(others).toEqual([])
    expect(scriptArguments(call)).toEqual([String(prelude.length), '0', '--nsInclude', 'production.users', '--nsInclude', 'production.orders'])
    const script = scriptOf(call)
    const steps = ['the archive was not received whole', 'restore_into "$STAGING" "$@"', '[ "$whole" = 0 ] || drop DB', 'restore_into "$DB" "$@"'].map(step => script.indexOf(step))
    expect(steps).toEqual([...steps].sort((first, second) => first - second))
    expect(steps[0]).toBeGreaterThan(0)
    expect(script).toContain('--archive="$ARCHIVE"')
  })

  it('asks for the database to be emptied for a whole archive only', async () => {
    const prelude = mongodumpPrelude([['production', 'users']])
    await mongodb.restoreNative({ container: 'mongo', database: 'catalog' }, await stored(prelude), null)

    expect((await dockerCalls()).map(scriptArguments)).toEqual([[String(prelude.length), '1']])
  })

  it('refuses an archive listing no collection, which would only empty the database', async () => {
    const archive = await stored(mongodumpPrelude([]))
    await expect(mongodb.restoreNative({ container: 'mongo', database: 'catalog' }, archive, null)).rejects.toThrow('the archive holds no collection')
    expect(await dockerCalls()).toEqual([])
  })

  it('refuses to dump a database without collection, which mongodump would dump as an empty archive', async () => {
    for await (const chunk of mongodb.dumpNative({ container: 'mongo', database: 'catalog' })) {
      void chunk
    }
    const [call] = await dockerCalls()

    const empty = await runScript(call, '', { mongosh: 'echo 0', mongodump: 'exit 0' })
    expect([empty.code, empty.stderr.trim()]).toEqual([1, 'the database catalog has no collection: there is nothing to dump'])
    expect(empty.calls.filter(line => line.startsWith('mongodump'))).toEqual([])

    const filled = await runScript(call, '', { mongosh: 'echo 2', mongodump: 'exit 0' })
    expect(filled.code).toBe(0)
    expect(filled.calls.at(-1)).toBe('mongodump --quiet --archive --gzip --db catalog')
  })

  it('refuses an archive that is not gzip-compressed, naming the expected format', async () => {
    await expect(mongodb.restoreNative({ container: 'mongo', database: 'catalog' }, await stored(Buffer.from('plain')), null)).rejects.toThrow('not a complete gzip-compressed archive')
    expect(await dockerCalls()).toEqual([])
  })

  it('refuses an archive of several databases, whose collections would be mixed', async () => {
    const archive = await stored(mongodumpPrelude([['east', 'users'], ['west', 'users']]))
    await expect(mongodb.restoreNative({ container: 'mongo', database: 'catalog' }, archive, null)).rejects.toThrow('the archive holds several databases (east, west)')
    await expect(mongodb.restoreNative({ container: 'mongo', database: 'catalog' }, archive, ['users'])).rejects.toThrow('several databases')
    expect(await dockerCalls()).toEqual([])
  })

  it.each(['mongodb', 'postgres'] as const)('refuses an empty list of tables in a %s archive, which would select every table', async name => {
    const archive = await stored(mongodumpPrelude([['production', 'users']]))
    await expect(databaseEngine(name).restoreNative({ container: 'db', database: 'catalog' }, archive, [])).rejects.toThrow('no table chosen')
    expect(await dockerCalls()).toEqual([])
  })

  it('refuses collections the archive does not hold', async () => {
    const archive = await stored(mongodumpPrelude([['production', 'users']]))
    await expect(mongodb.restoreNative({ container: 'mongo', database: 'catalog' }, archive, ['users', 'orders'])).rejects.toThrow('not in the archive: orders')
    expect(await dockerCalls()).toEqual([])
  })

  it('refuses an archive whose list of collections is missing or corrupted', async () => {
    const header = Buffer.concat([MAGIC, bsonDocument({ version: '0.1' })])
    const farOverrun = bsonDocument({ db: 'production', collection: 'users' })
    farOverrun.writeInt32LE(1_000_000, 4 + 1 + 'db'.length + 1)
    const smallOverrun = bsonDocument({ db: 'production', collection: 'users' })
    smallOverrun.writeInt32LE(smallOverrun.length - 8 - 2, 4 + 1 + 'db'.length + 1)
    const oversized = Buffer.alloc(4)
    oversized.writeInt32LE(64 * 1024 * 1024)
    const cases: [string, Buffer][] = [
      ['not a mongodump archive', Buffer.from('-- MariaDB dump')],
      ['no complete list of collections', MAGIC],
      ['no header', Buffer.concat([MAGIC, TERMINATOR])],
      ['one of its documents is corrupted', Buffer.concat([header, Buffer.alloc(4)])],
      ['one of its documents is corrupted', Buffer.concat([header, oversized])],
      ['one of its documents is corrupted', Buffer.concat([header, farOverrun])],
      ['one of its documents is corrupted', Buffer.concat([header, smallOverrun])],
      ['no complete list of collections', Buffer.concat([header, bsonDocument({ db: 'production', collection: 'users' })])]
    ]
    for (const [message, content] of cases) {
      await expect(mongodb.restoreNative({ container: 'mongo', database: 'catalog' }, await stored(gzipSync(content)), null), message).rejects.toThrow(message)
    }
    expect(await dockerCalls()).toEqual([])
  })
})

describe('postgres native archives', () => {
  const postgres = databaseEngine('postgres')

  it('sends a whole archive in one run of the container, with its size and the database of the item', async () => {
    await postgres.restoreNative({ container: 'pg', database: 'sales=2026' }, await stored(Buffer.from('archive')), null)

    const [call, ...others] = await dockerCalls()
    expect(others).toEqual([])
    expect(call.slice(0, 5)).toEqual(['exec', '-i', '-e', 'ADT_DATABASE=sales=2026', 'pg'])
    expect(scriptArguments(call)).toEqual(['7'])
  })

  it('restores some tables as rows only, each schema and table paired, and repairs their sequences only', async () => {
    await postgres.restoreNative({ container: 'pg', database: null }, await stored(Buffer.from('archive')), ['public.users', '"Sales"."Orders"'])

    const [call] = await dockerCalls()
    const [size, before, after, ...pairs] = scriptArguments(call)
    expect(size).toBe('7')
    expect(before).toBe('DELETE FROM ONLY public.users; DELETE FROM ONLY "Sales"."Orders";')
    expect(after).toContain(`SELECT unnest(ARRAY['public.users', '"Sales"."Orders"']::regclass[])::oid UNION SELECT i.inhparent FROM pg_inherits`)
    expect(pairs).toEqual(['public', 'users', 'Sales', 'Orders'])
    const script = scriptOf(call)
    expect(script).toContain('is not in the archive')
    expect(script).toContain('pg_restore -l -n "$1" -t "$2"')
    expect(script).toContain(`grep -E '^[0-9]+; [0-9]+ [0-9]+ TABLE DATA '`)
    expect(script).toContain('pg_restore --data-only -L')
  })

  it('names the database literally in every client call', async () => {
    const target = { container: 'pg', database: 'sales=2026' }
    await postgres.listTables(target)
    for await (const chunk of postgres.dumpNative(target)) {
      void chunk
    }

    for (const call of await dockerCalls()) {
      expect(scriptOf(call)).toContain(`CONN="dbname='$(printf '%s' "$DB" | sed`)
      expect(scriptOf(call)).toContain('-d "$CONN"')
    }
  })
})

describe('postgres whole restore script', () => {
  const pg = {
    pg_restore: 'exit 0',
    psql: 'case "$(cat)" in *\'RENAME TO :"replaced"\'*) echo replaced ;; esac; touch "$TMPDIR/../swapped"',
    dropdb: 'case "$*" in *adt_replaced*) [ ! -e "$TMPDIR/../swapped" ] || exit 1 ;; esac'
  }

  let call: string[]

  beforeEach(async () => {
    await databaseEngine('postgres').restoreNative({ container: 'pg', database: 'sales' }, await stored(Buffer.from('archive')), null)
    ;[call] = await dockerCalls()
  })

  it('restores into a database of a new random name, dropping no database it did not create', async () => {
    const runs = [await runScript(call, 'archive', pg), await runScript(call, 'archive', pg)]
    const stagings = runs.map(run => /^psql -U postgres -d template1 .*-v staging=(\S+) /.exec(run.calls[0])?.[1])

    expect(stagings[0]).toMatch(/^adt_staging_[0-9a-f]{16}$/)
    expect(stagings[1]).not.toBe(stagings[0])
    expect(runs[0].calls.filter(line => line.startsWith('dropdb')).map(line => line.split(' ').at(-1))).toEqual([stagings[0]?.replace('staging', 'replaced')])
  })

  it('drops nothing when a database of that name already exists', async () => {
    const run = await runScript(call, 'archive', { ...pg, psql: 'cat > /dev/null; echo "ERROR:  database already exists" >&2; exit 1' })
    expect(run.code).toBe(1)
    expect(run.calls).toHaveLength(1)
  })

  it('succeeds once the database is replaced, reporting a former copy it cannot drop', async () => {
    const run = await runScript(call, 'archive', pg)
    expect(run.code).toBe(0)
    expect(run.stdout.trim()).toMatch(/^its former copy adt_replaced_[0-9a-f]{16} could not be dropped: drop it by hand$/)
    expect(run.leftovers).toEqual([])
  })

  it('applies the privileges the archive grants, once its objects are restored and before the swap', async () => {
    const run = await runScript(call, 'archive', {
      ...pg,
      pg_restore: 'case "$*" in "-l "*) echo "9; 0 0 ACL public TABLE users postgres" ;; *"-L "*) echo "GRANT SELECT ON TABLE public.users TO reader;" ;; esac'
    })
    expect(run.code).toBe(0)
    const steps = run.calls.map(line => line.split(' ').slice(0, 2).join(' '))
    expect(steps).toEqual(['psql -U', 'pg_restore -U', 'pg_restore -l', 'pg_restore -L', 'psql -U', 'psql -U', 'dropdb -U'])
    expect(run.calls[3]).toMatch(/^pg_restore -L \S+\/grants -f \S+\/grants\.sql /)
    expect(run.calls[4]).toMatch(/^psql -U postgres -d dbname='adt_staging_[0-9a-f]{16}' -X -q -f \S+\/grants\.sql$/)
  })

  it.each([
    ['skips privileges granted to roles the server lacks', 'echo \'psql:grants.sql:3: ERROR:  role "departed" does not exist\' >&2', 0],
    ['refuses the archive, changing nothing, when another privilege is refused', 'echo \'psql:grants.sql:3: ERROR:  permission denied for schema private\' >&2', 1],
    ['refuses the archive, changing nothing, when the client applying the privileges fails', 'echo \'psql: error: connection to server lost\' >&2; exit 2', 1]
  ])('%s', async (_case, grants, code) => {
    const run = await runScript(call, 'archive', {
      ...pg,
      pg_restore: 'case "$*" in "-l "*) echo "9; 0 0 ACL public TABLE users postgres" ;; esac',
      psql: `case "$*" in *" -f "*) ${grants} ;; *) ${pg.psql} ;; esac`
    })
    expect(run.code).toBe(code)
    expect(run.calls.some(line => line.includes(' -v replaced='))).toBe(code === 0)
    expect(run.leftovers).toEqual([])
  })

  it('drops no former copy when the database did not exist, whatever database holds that name', async () => {
    const run = await runScript(call, 'archive', { ...pg, psql: 'cat > /dev/null', dropdb: 'exit 0' })
    expect([run.code, run.stdout, run.leftovers]).toEqual([0, '', []])
    expect(run.calls.filter(line => line.startsWith('dropdb'))).toEqual([])
  })

  it('reports nothing when the former copy is dropped', async () => {
    const run = await runScript(call, 'archive', { ...pg, dropdb: 'exit 0' })
    expect([run.code, run.stdout]).toEqual([0, ''])
  })

  it('changes nothing when the archive was not received whole', async () => {
    const run = await runScript(call, 'arch', pg)
    expect([run.code, run.stderr.trim(), run.calls, run.leftovers]).toEqual([1, 'the archive was not received whole: nothing was changed', [], []])
  })
})

describe('mongodb restore script', () => {
  const received = (restore: string[]): string => 'x'.repeat(Number(scriptArguments(restore)[0]))
  const mongo = (behaviour: { exists?: boolean, save?: string, load?: string, putBack?: string } = {}): Record<string, string> => ({
    mongosh: `case "$*" in *getDBNames*) exit ${behaviour.exists === true ? 1 : 0} ;; esac`,
    mongodump: behaviour.save ?? 'for arg; do case "$arg" in --archive=*) : > "${arg#--archive=}" ;; esac; done',
    mongorestore: `case "$*" in *"--nsTo catalog."*) ${behaviour.load ?? 'exit 0'} ;; *"--nsTo adt_staging_"*) exit 0 ;; *) ${behaviour.putBack ?? 'exit 0'} ;; esac`
  })
  let call: string[]

  beforeEach(async () => {
    await databaseEngine('mongodb').restoreNative({ container: 'mongo', database: 'catalog' }, await stored(mongodumpPrelude([['production', 'users']])), null)
    ;[call] = await dockerCalls()
  })

  it('restores into a database of a new random name first, then saves, empties and restores the database, stopping at the first error', async () => {
    const run = await runScript(call, received(call), mongo())
    const staging = /--nsTo (adt_staging_[0-9a-f]{16})\.\$coll\$/.exec(run.calls.join('\n'))?.[1]

    expect([run.code, run.leftovers]).toEqual([0, []])
    expect(staging).toBeDefined()
    expect(run.calls.map(line => line.split(' ')[0])).toEqual(['mongosh', 'mongorestore', 'mongodump', 'mongosh', 'mongorestore', 'mongosh'])
    expect(run.calls[2]).toMatch(/^mongodump --quiet --archive=\S+\.saved --gzip --db catalog$/)
    expect(run.calls[4]).toContain('--nsTo catalog.$coll$')
    expect(run.calls.filter(line => line.startsWith('mongorestore')).every(line => line.includes('--stopOnError'))).toBe(true)
  })

  it('puts the saved database back when its restore fails', async () => {
    const run = await runScript(call, received(call), mongo({ load: 'exit 1' }))
    expect([run.code, run.stderr.trim(), run.leftovers]).toEqual([1, 'the restore was refused: the database was put back as it was', []])
    expect(run.calls.at(-2)).toMatch(/^mongorestore --archive=\S+\.saved --gzip --stopOnError$/)
  })

  it('keeps the saved dump in the container when the database cannot be put back', async () => {
    const run = await runScript(call, received(call), mongo({ load: 'exit 1', putBack: 'exit 1' }))
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('the database could not be put back: its dump is kept in the container')
    expect(run.leftovers).toHaveLength(1)
  })

  it('changes nothing when the database cannot be saved', async () => {
    const run = await runScript(call, received(call), mongo({ save: 'exit 1' }))
    expect([run.code, run.stderr.trim(), run.leftovers]).toEqual([1, 'the database could not be saved before its restore: nothing was changed', []])
    expect(run.calls.some(line => line.includes('--nsTo catalog.'))).toBe(false)
  })

  it('reports a temporary database it cannot drop, the database restored', async () => {
    const run = await runScript(call, received(call), { ...mongo(), mongosh: 'case "$*" in *getDBNames*) exit 0 ;; *STAGING*) exit 1 ;; esac' })
    expect(run.code).toBe(0)
    expect(run.stdout.trim()).toMatch(/^the temporary database adt_staging_[0-9a-f]{16} could not be dropped: drop it by hand$/)
  })

  it('drops nothing when a database of that name already exists', async () => {
    const run = await runScript(call, received(call), mongo({ exists: true }))
    expect(run.code).toBe(1)
    expect(run.stderr).toMatch(/^the database adt_staging_[0-9a-f]{16} already exists: nothing was changed, try again$/m)
    expect(run.calls).toHaveLength(1)
  })
})

describe('mariadb native archives', () => {
  const mariadb = databaseEngine('mariadb')
  const target = { container: 'db', database: 'shop' }

  it('ends the options of every client before a database or table name, so a name like an option stays a name', async () => {
    const named = { container: 'db', database: '--all-databases' }
    await mariadb.listTables(named)
    for (const output of [mariadb.dumpSchema(named), mariadb.dumpTable(named, '--t')]) {
      for await (const chunk of output) {
        void chunk
      }
    }
    await mariadb.importSchema(named, Readable.from([]))
    await mariadb.importTable(named, '--t', Readable.from([]), false)
    for await (const chunk of mariadb.dumpNative(named)) {
      void chunk
    }

    const calls = await dockerCalls()
    const ends: string[] = []
    for (const call of calls) {
      const run = await runScript(call, '', { 'mariadb': 'cat > /dev/null', 'mariadb-dump': 'exit 0' })
      ends.push(run.calls.map(line => line.slice(line.indexOf(' -- '))).join(''))
    }
    expect(ends).toEqual([' -- --all-databases', ' -- --all-databases', ' -- --all-databases --t', ' -- --all-databases', ' -- --all-databases', ' -- --all-databases'])
  })

  describe('restore script', () => {
    const dump = '-- ARCHIVE DUMP\nCREATE TABLE t (id int);\n'
    const probeLatin1 = 'printf \'latin1\\tlatin1_swedish_ci\\n\''
    const probeMissing = 'echo "ERROR 1049 (42000) at line 1: Unknown database \'shop\'" >&2; exit 1'
    let call: string[]

    /**
     * Runs the restore script with a fake server.
     * @param behaviour - Shell commands of the fake server: `probe` answers the character set of the database, `save` dumps it, `grant` grants it to the account of the container, `load` loads the archive, `putBack` loads the saved dump.
     * @param input - The archive received.
     * @returns What the script did.
     */
    async function restore (behaviour: { probe?: string, save?: string, grant?: string, load?: string, putBack?: string }, input = dump): Promise<ScriptRun> {
      const mariadb = `case "$*" in
  *@@character_set_database*) ${behaviour.probe ?? probeLatin1} ;;
  *GRANT*) ${behaviour.grant ?? 'exit 0'} ;;
  *"DROP DATABASE"*) exit 0 ;;
  *) case "$(cat)" in *"ARCHIVE DUMP"*) ${behaviour.load ?? 'exit 0'} ;; *) ${behaviour.putBack ?? 'exit 0'} ;; esac ;;
esac`
      return runScript(call, input, { mariadb, 'mariadb-dump': `echo '-- SAVED DUMP'; ${behaviour.save ?? 'exit 0'}` }, { MARIADB_ROOT_PASSWORD: 'secret', MARIADB_USER: 'app' })
    }

    beforeEach(async () => {
      await mariadb.restoreNative(target, await stored(gzipSync(dump)), null)
      ;[call] = await dockerCalls()
    })

    it('loads the dump in the sandbox mode of the client, once the database is saved and recreated with its character set and collation', async () => {
      const run = await restore({})
      expect([run.code, run.stdout, run.stderr, run.leftovers]).toEqual([0, '', '', []])
      expect(run.calls).toEqual([
        'mariadb -uroot -N -B -e USE `shop`; SELECT @@character_set_database, @@collation_database',
        'mariadb-dump -uroot --single-transaction --routines --triggers --events -- shop',
        'mariadb -uroot -e DROP DATABASE IF EXISTS `shop`; CREATE DATABASE `shop` CHARACTER SET latin1 COLLATE latin1_swedish_ci',
        'mariadb -uroot -e GRANT ALL PRIVILEGES ON `shop`.* TO \'app\'@\'%\'',
        'mariadb -uroot --sandbox --local-infile=0 -- shop'
      ])
    })

    it('grants a database whose name holds wildcards of privilege targets as that name only', async () => {
      await mariadb.restoreNative({ container: 'db', database: 'sales_2026%' }, await stored(gzipSync(dump)), null)
      const fakes = {
        'mariadb': 'case "$*" in *@@character_set_database*) printf \'latin1\\tlatin1_swedish_ci\\n\' ;; esac',
        'mariadb-dump': 'exit 0'
      }
      const run = await runScript((await dockerCalls())[1], dump, fakes, { MARIADB_USER: 'app' })

      expect(run.code).toBe(0)
      expect(run.calls.filter(line => line.includes('GRANT ALL'))).toEqual(['mariadb -uroot -e GRANT ALL PRIVILEGES ON `sales\\_2026\\%`.* TO \'app\'@\'%\''])
    })

    it.each([
      ['the dump', { load: 'exit 1' }],
      ['the grant', { grant: 'exit 1' }]
    ])('puts the saved database back when the server refuses %s', async (_step, behaviour) => {
      const run = await restore(behaviour)
      expect([run.code, run.stderr.trim(), run.leftovers]).toEqual([1, 'the restore was refused: the database was put back as it was', []])
      expect(run.calls.slice(-2)).toEqual([
        'mariadb -uroot -e DROP DATABASE IF EXISTS `shop`; CREATE DATABASE `shop` CHARACTER SET latin1 COLLATE latin1_swedish_ci',
        'mariadb -uroot -- shop'
      ])
    })

    it('keeps the saved dump in the container when the database cannot be put back', async () => {
      const run = await restore({ load: 'exit 1', putBack: 'exit 1' })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('the database could not be put back: its dump is kept in the container')
      expect(run.leftovers).toHaveLength(1)
    })

    it('changes nothing when the database cannot be saved', async () => {
      const run = await restore({ save: 'exit 1' })
      expect([run.code, run.stderr.trim(), run.leftovers]).toEqual([1, 'the database could not be saved before its restore, so nothing was changed: repair it, or drop it to restore the archive into a new database', []])
      expect(run.calls.some(line => line.includes('DROP DATABASE'))).toBe(false)
    })

    it('changes nothing when the server cannot tell whether the database exists', async () => {
      const run = await restore({ probe: 'echo "ERROR 2002 (HY000): Can\'t connect to local server" >&2; exit 1' })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('the server could not tell whether the database exists: nothing was changed')
      expect(run.calls.filter(line => line.includes('DATABASE') || line.startsWith('mariadb-dump'))).toEqual([])
    })

    it('removes a database that did not exist when the dump is refused', async () => {
      const run = await restore({ probe: probeMissing, load: 'exit 1' })
      expect([run.code, run.stderr.trim(), run.leftovers]).toEqual([1, 'the restore was refused: the database, which did not exist, was removed', []])
      expect(run.calls.some(line => line.startsWith('mariadb-dump'))).toBe(false)
      expect(run.calls.at(-1)).toBe('mariadb -uroot -e DROP DATABASE IF EXISTS `shop`')
    })

    it('changes nothing when the dump was not received whole', async () => {
      const run = await restore({}, dump.slice(0, 10))
      expect([run.code, run.stderr.trim(), run.calls, run.leftovers]).toEqual([1, 'the archive was not received whole: nothing was changed', [], []])
    })
  })

  it('refuses to restore some tables', async () => {
    await expect(mariadb.restoreNative(target, await stored(gzipSync('-- dump')), ['users'])).rejects.toThrow('restores the whole database only')
    expect(await dockerCalls()).toEqual([])
  })

  it('refuses an archive holding an empty dump before reaching the container', async () => {
    await expect(mariadb.restoreNative(target, await stored(gzipSync('')), null)).rejects.toThrow('the archive holds an empty dump')
    expect(await dockerCalls()).toEqual([])
  })

  it('refuses a truncated or uncompressed archive before reaching the container', async () => {
    const archive = gzipSync(`-- MariaDB dump\n${'INSERT INTO t VALUES (1);\n'.repeat(1000)}`)
    await expect(mariadb.restoreNative(target, await stored(archive.subarray(0, archive.length - 40)), null)).rejects.toThrow('not a complete gzip-compressed archive')
    await expect(mariadb.restoreNative(target, await stored(Buffer.from('-- MariaDB dump\n')), null)).rejects.toThrow('not a complete gzip-compressed archive')
    expect(await dockerCalls()).toEqual([])
  })

  it.each([
    'USE `shop`;',
    'use shop;',
    '  USE `shop`;',
    'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `shop`;',
    '/*!40000 DROP DATABASE IF EXISTS `shop`*/;',
    'DROP SCHEMA other;',
    'CREATE OR REPLACE DATABASE other;',
    'create schema if not exists other;',
    '/*M!100100 DROP DATABASE other*/;'
  ])('refuses a dump naming its own database with %s', async statement => {
    const dump = `-- MariaDB dump\n${'-- filler\n'.repeat(5000)}${statement}\nCREATE TABLE t (id int);\n`
    await expect(mariadb.restoreNative(target, await stored(gzipSync(dump)), null)).rejects.toThrow('the dump names its own database')
    expect(await dockerCalls()).toEqual([])
  })

  it('accepts statements that only look like a database statement inside a line', async () => {
    const dump = `-- MariaDB dump\nINSERT INTO t VALUES ('USE \`shop\`;'), ('CREATE DATABASE x');\nCREATE TABLE user_agents (id int);\n`
    await mariadb.restoreNative(target, await stored(gzipSync(dump)), null)
    expect(await dockerCalls()).toHaveLength(1)
  })

  it('leaves alone the body of a routine, which may drop a database of its own', async () => {
    const routine = 'DELIMITER ;;\nCREATE PROCEDURE cleanup()\nBEGIN\n  /*\n  Use this to clean up.\n  */\nDROP DATABASE IF EXISTS scratch;\nEND ;;\nDELIMITER ;\n'
    const accepted = `-- dump\n${routine}CREATE TABLE t (id int);\n`
    await expect(assertDatabaseLessDump(Readable.from([Buffer.from(accepted)]))).resolves.toBe(accepted.length)
    await expect(assertDatabaseLessDump(Readable.from([Buffer.from(`-- dump\n${routine}USE \`shop\`;\n`)]))).rejects.toThrow('the dump names its own database')
  })

  it('finds a database statement wherever the dump is cut into chunks', async () => {
    const refused = Buffer.from(`-- MariaDB dump\n${'x'.repeat(100)}\nUSE \`shop\`;\nCREATE TABLE t (id int);`)
    const accepted = Buffer.from(`-- MariaDB dump\n${'x'.repeat(100)} USE \`shop\`;\nINSERT INTO t VALUES ('\\nUSE x');\nCREATE TABLE user_agents (id int)`)
    for (let cut = 0; cut <= refused.length; cut += 1) {
      await expect(assertDatabaseLessDump(Readable.from([refused.subarray(0, cut), refused.subarray(cut)])), `cut at ${cut}`).rejects.toThrow('the dump names its own database (USE `shop`;)')
    }
    for (let cut = 0; cut <= accepted.length; cut += 1) {
      await expect(assertDatabaseLessDump(Readable.from([accepted.subarray(0, cut), accepted.subarray(cut)])), `cut at ${cut}`).resolves.toBe(accepted.length)
    }
  })
})
