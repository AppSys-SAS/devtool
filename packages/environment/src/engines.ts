import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { transformed } from './archive.js'

/** Database engines a local container can run. */
export type DatabaseEngineName = 'postgres' | 'mariadb' | 'mongodb'

/** A database of a container. */
export interface DatabaseTarget {
  container: string
  /** Its name in the container, null for the database the image creates. */
  database: string | null
}

/** Dump and restore operations of a database engine, run inside its container. */
export interface DatabaseEngine {
  /** Lists the tables of the database, as identifiers usable in SQL. */
  listTables(target: DatabaseTarget): Promise<string[]>
  /** Dumps the schema of the database, without data. */
  dumpSchema(target: DatabaseTarget): AsyncIterable<Buffer>
  /** Dumps the rows of a table, without its definition. */
  dumpTable(target: DatabaseTarget, table: string): AsyncIterable<Buffer>
  /** Drops and recreates the database, empty. */
  reset(target: DatabaseTarget): Promise<void>
  /** Runs a schema dump. */
  importSchema(target: DatabaseTarget, sql: AsyncIterable<Buffer>): Promise<void>
  /** Loads the rows of a table, foreign keys unchecked, emptying the table first when asked. */
  importTable(target: DatabaseTarget, table: string, sql: AsyncIterable<Buffer>, replace: boolean): Promise<void>
  /** Brings what depends on loaded rows, such as sequences, in line with them. */
  finish(target: DatabaseTarget): Promise<void>
  /** First bytes of every archive of the engine's own tools. */
  readonly nativeMagic: Buffer
  /** Dumps the whole database in the archive format of the engine's own tools. */
  dumpNative(target: DatabaseTarget): AsyncIterable<Buffer>
  /** Loads an archive of the engine's own tools: every table into an emptied database, or the rows of some tables, replaced. */
  restoreNative(target: DatabaseTarget, archive: AsyncIterable<Buffer>, tables: string[] | null): Promise<void>
}

const STDERR_TAIL_BYTES = 4096
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b])

/**
 * Keeps the end of the error output of a process.
 *
 * @param child - The process.
 * @returns A function giving the collected text.
 */
function collectErrors (child: ChildProcess): () => string {
  let tail = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf-8')).slice(-STDERR_TAIL_BYTES)
  })

  return () => tail.trim()
}

/**
 * Waits for a process to exit and fails when it exits with an error.
 *
 * @param child - The process.
 * @param errors - The collected error output.
 * @param label - What the process does, for the error message.
 */
async function assertExit (child: ChildProcess, errors: () => string, label: string): Promise<void> {
  const [code] = (child.exitCode !== null ? [child.exitCode] : await once(child, 'close')) as [number | null]
  if (code !== 0) {
    throw new Error(`${label} failed (exit ${code}): ${errors()}`)
  }
}

/**
 * Builds the arguments of `docker exec` running a shell script in the container of a database,
 * the script reading the name of the database, when given, as `$ADT_DATABASE`.
 *
 * @param target - The database.
 * @param interactive - Whether the script reads its standard input.
 * @param script - The script, reading its arguments as `$1`, `$2`...
 * @param args - The arguments of the script.
 * @returns The arguments of `docker`.
 */
function dockerExec (target: DatabaseTarget, interactive: boolean, script: string, args: string[]): string[] {
  return [
    'exec',
    ...(interactive ? ['-i'] : []),
    ...(target.database === null ? [] : ['-e', `ADT_DATABASE=${target.database}`]),
    target.container,
    'sh',
    '-c',
    script,
    'sh',
    ...args
  ]
}

/**
 * Runs a shell script in a container, streaming its output.
 *
 * @param target - The database whose container runs the script.
 * @param script - The script, reading its arguments as `$1`, `$2`...
 * @param args - The arguments of the script.
 * @returns The output, failing at its end when the script failed.
 */
async function* scriptOutput (target: DatabaseTarget, script: string, args: string[] = []): AsyncGenerator<Buffer> {
  const child = spawn('docker', dockerExec(target, false, script, args), { stdio: ['ignore', 'pipe', 'pipe'] })
  const errors = collectErrors(child)
  const exited = assertExit(child, errors, `docker exec ${target.container}`)
  exited.catch(() => undefined)
  try {
    for await (const chunk of child.stdout) {
      yield chunk as Buffer
    }
    await exited
  } finally {
    if (child.exitCode === null) {
      child.kill()
    }
  }
}

/**
 * Runs a shell script in a container and reads its whole output.
 *
 * @param target - The database whose container runs the script.
 * @param script - The script.
 * @returns The output text.
 */
async function scriptText (target: DatabaseTarget, script: string): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of scriptOutput(target, script)) {
    chunks.push(chunk)
  }

  return Buffer.concat(chunks).toString('utf-8')
}

/**
 * Runs a shell script in a container with an input.
 *
 * @param target - The database whose container runs the script.
 * @param script - The script, reading its arguments as `$1`, `$2`...
 * @param input - The standard input of the script.
 * @param args - The arguments of the script.
 */
async function scriptInput (target: DatabaseTarget, script: string, input: AsyncIterable<Buffer>, args: string[] = []): Promise<void> {
  const child = spawn('docker', dockerExec(target, true, script, args), { stdio: ['pipe', 'ignore', 'pipe'] })
  const errors = collectErrors(child)
  const piped = pipeline(Readable.from(input), child.stdin).then(() => null, (error: unknown) => (error instanceof Error ? error : new Error(String(error))))
  await assertExit(child, errors, `docker exec ${target.container}`)
  const pipeError = await piped
  if (pipeError) {
    throw pipeError
  }
}

/**
 * Puts a text before a stream.
 *
 * @param prefix - The text.
 * @param body - The stream.
 * @returns The concatenation.
 */
async function* prefixed (prefix: string, body: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  yield Buffer.from(prefix)
  yield* body
}

/**
 * Turns a text into a stream.
 *
 * @param text - The text.
 * @returns A stream of one chunk.
 */
function textStream (text: string): AsyncIterable<Buffer> {
  return Readable.from([Buffer.from(text)])
}

/**
 * Builds the line of a script setting `$DB`, the database of the target, to the one the image
 * creates when the target names none.
 *
 * @param variable - The environment variable of the image naming its database.
 * @returns The script line.
 */
function databaseSetup (variable: string): string {
  return `DB="\${ADT_DATABASE:-$${variable}}"
[ -n "$DB" ] || { echo "no database: set database on the item or ${variable} in the container" >&2; exit 1; }
`
}

/**
 * Unquotes an identifier PostgreSQL quoted with `%I`.
 *
 * @param identifier - The identifier, quoted or not.
 * @returns The name.
 */
function unquotePostgres (identifier: string): string {
  return identifier.startsWith('"') ? identifier.slice(1, -1).replaceAll('""', '"') : identifier
}

/**
 * Splits a `schema.table` name of PostgreSQL, each part quoted with `%I`.
 *
 * @param name - The qualified name.
 * @returns The schema and the table, unquoted.
 */
export function splitPostgresName (name: string): { schema: string, table: string } {
  const match = /^("(?:[^"]|"")*"|[^."]*)\.("(?:[^"]|"")*"|[^."]*)$/.exec(name)
  if (!match) {
    throw new Error(`not a schema.table name: ${name}`)
  }
  return { schema: unquotePostgres(match[1]), table: unquotePostgres(match[2]) }
}

const POSTGRES_SETUP = `: "\${POSTGRES_USER:=postgres}"
${databaseSetup('POSTGRES_DB')}`
const POSTGRES_CLIENT = 'psql -U "$POSTGRES_USER" -d "$DB" -X -q -v ON_ERROR_STOP=1'
const POSTGRES_SEQUENCES_SQL = `DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT a.attrelid::regclass AS rel, a.attname, pg_get_serial_sequence(a.attrelid::regclass::text, a.attname) AS seq
    FROM pg_attribute a
    JOIN pg_class r ON r.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE r.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  LOOP
    IF c.seq IS NOT NULL THEN
      EXECUTE format('SELECT setval(%L, coalesce((SELECT max(%I) FROM %s), 0) + 1, false)', c.seq, c.attname, c.rel);
    END IF;
  END LOOP;
END $$;
`

/**
 * Replaces the rows of some tables by those of a `pg_dump -Fc` archive read on the standard input, in
 * one transaction, foreign keys unchecked: `$1` empties the tables, then each pair of arguments names
 * the schema and the table of an archive entry, which must exist.
 */
const POSTGRES_PARTIAL_RESTORE = `set -e
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/archive"
pg_restore -l "$work/archive" > "$work/toc"
empty="$1"; shift
: > "$work/list"
while [ $# -gt 0 ]; do
  awk -v schema="$1" -v table="$2" '$4 == "TABLE" && $5 == "DATA" && $6 == schema && $7 == table' "$work/toc" > "$work/entry"
  [ -s "$work/entry" ] || { echo "$1.$2 is not in the archive" >&2; exit 1; }
  cat "$work/entry" >> "$work/list"
  shift 2
done
pg_restore --data-only -L "$work/list" -f "$work/data.sql" "$work/archive"
{ printf 'SET session_replication_role = replica;\\n%s\\n' "$empty"; cat "$work/data.sql"; } | ${POSTGRES_CLIENT} -1
`

/** PostgreSQL of the official image: local socket, credentials from the container environment. */
const postgres: DatabaseEngine = {
  async listTables (target) {
    const text = await scriptText(
      target,
      `${POSTGRES_SETUP}${POSTGRES_CLIENT} -At -c "SELECT format('%I.%I', schemaname, tablename) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1"`
    )
    return text.split('\n').filter(line => line !== '')
  },
  dumpSchema (target) {
    return scriptOutput(target, `${POSTGRES_SETUP}pg_dump -U "$POSTGRES_USER" --schema-only --no-owner --no-privileges "$DB"`)
  },
  dumpTable (target, table) {
    return scriptOutput(target, `${POSTGRES_SETUP}pg_dump -U "$POSTGRES_USER" --data-only --no-owner --no-privileges -t "$1" "$DB"`, [table])
  },
  async reset (target) {
    await scriptText(target, `${POSTGRES_SETUP}dropdb -U "$POSTGRES_USER" --force --if-exists "$DB" && createdb -U "$POSTGRES_USER" "$DB"`)
  },
  async importSchema (target, sql) {
    await scriptInput(target, `${POSTGRES_SETUP}${POSTGRES_CLIENT}`, sql)
  },
  async importTable (target, table, sql, replace) {
    const preamble = `SET session_replication_role = replica;\n${replace ? `DELETE FROM ${table};\n` : ''}`
    await scriptInput(target, `${POSTGRES_SETUP}${POSTGRES_CLIENT}`, prefixed(preamble, sql))
  },
  async finish (target) {
    await scriptInput(target, `${POSTGRES_SETUP}${POSTGRES_CLIENT}`, textStream(POSTGRES_SEQUENCES_SQL))
  },
  nativeMagic: Buffer.from('PGDMP'),
  dumpNative (target) {
    return scriptOutput(target, `${POSTGRES_SETUP}pg_dump -U "$POSTGRES_USER" -Fc "$DB"`)
  },
  async restoreNative (target, archive, tables) {
    if (tables === null) {
      await scriptInput(target, `${POSTGRES_SETUP}pg_restore -U "$POSTGRES_USER" -d "$DB" --no-owner --no-privileges --exit-on-error`, archive)
      return
    }

    const empty = tables.map(table => `DELETE FROM ${table};`).join(' ')
    const selection = tables.flatMap(table => {
      const { schema, table: name } = splitPostgresName(table)
      return [schema, name]
    })
    await scriptInput(target, `${POSTGRES_SETUP}${POSTGRES_PARTIAL_RESTORE}`, archive, [empty, ...selection])
  }
}

const MARIADB_SETUP = `${databaseSetup('MARIADB_DATABASE')}export MYSQL_PWD="$MARIADB_ROOT_PASSWORD"
`

/**
 * Quotes a MariaDB identifier.
 *
 * @param name - The identifier.
 * @returns The quoted identifier.
 */
function quoteMariadb (name: string): string {
  return `\`${name.replaceAll('`', '``')}\``
}

/** MariaDB of the official image: root account, credentials from the container environment. */
const mariadb: DatabaseEngine = {
  async listTables (target) {
    const text = await scriptText(target, `${MARIADB_SETUP}mariadb -uroot -N -B -e "SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'" "$DB"`)
    return text
      .split('\n')
      .filter(line => line !== '')
      .map(line => line.split('\t')[0])
  },
  dumpSchema (target) {
    return scriptOutput(target, `${MARIADB_SETUP}mariadb-dump -uroot --no-data --routines --triggers --events --skip-comments "$DB"`)
  },
  dumpTable (target, table) {
    return scriptOutput(target, `${MARIADB_SETUP}mariadb-dump -uroot --no-create-info --skip-triggers --skip-comments --single-transaction "$DB" "$1"`, [table])
  },
  async reset (target) {
    await scriptText(
      target,
      `${MARIADB_SETUP}mariadb -uroot -e "DROP DATABASE IF EXISTS \\\`$DB\\\`; CREATE DATABASE \\\`$DB\\\`;\${MARIADB_USER:+ GRANT ALL PRIVILEGES ON \\\`$DB\\\`.* TO '$MARIADB_USER'@'%'}"`
    )
  },
  async importSchema (target, sql) {
    await scriptInput(target, `${MARIADB_SETUP}mariadb -uroot "$DB"`, sql)
  },
  async importTable (target, table, sql, replace) {
    const preamble = `SET FOREIGN_KEY_CHECKS = 0;\n${replace ? `DELETE FROM ${quoteMariadb(table)};\n` : ''}`
    await scriptInput(target, `${MARIADB_SETUP}mariadb -uroot "$DB"`, prefixed(preamble, sql))
  },
  finish () {
    return Promise.resolve()
  },
  nativeMagic: GZIP_MAGIC,
  dumpNative (target) {
    return transformed(scriptOutput(target, `${MARIADB_SETUP}mariadb-dump -uroot --single-transaction --routines --triggers --events "$DB"`), createGzip())
  },
  async restoreNative (target, archive, tables) {
    if (tables !== null) {
      throw new Error('a native mariadb archive is a SQL script: it restores the whole database only')
    }
    await scriptInput(target, `${MARIADB_SETUP}mariadb -uroot "$DB"`, transformed(archive, createGunzip()))
  }
}

/**
 * Prefix of the MongoDB scripts: `$DB`, the database, and `auth`, running a MongoDB tool with the
 * root credentials of the container when it declares some.
 */
const MONGODB_SETUP = `${databaseSetup('MONGO_INITDB_DATABASE')}auth() {
  if [ -n "$MONGO_INITDB_ROOT_USERNAME" ]; then
    "$@" --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin
  else
    "$@"
  fi
}
`

/**
 * Escapes the wildcards of a MongoDB namespace pattern.
 *
 * @param name - A collection name.
 * @returns The name, matching itself only.
 */
function escapeNamespace (name: string): string {
  return name.replace(/[\\*]/g, '\\$&')
}

/**
 * Gives an empty stream.
 *
 * @returns A stream without chunk.
 */
function emptyStream (): AsyncIterable<Buffer> {
  return Readable.from([])
}

/** MongoDB of the official image: collections as tables, credentials from the container environment. */
const mongodb: DatabaseEngine = {
  async listTables (target) {
    const text = await scriptText(
      target,
      `${MONGODB_SETUP}auth mongosh "$DB" --quiet --eval 'db.getCollectionNames().filter((name) => !name.startsWith("system.")).sort().forEach((name) => print(name))'`
    )
    return text.split('\n').filter(line => line !== '')
  },
  dumpSchema () {
    return emptyStream()
  },
  dumpTable (target, table) {
    return scriptOutput(target, `${MONGODB_SETUP}auth mongodump --quiet --archive --db "$DB" --collection "$1"`, [table])
  },
  async reset (target) {
    await scriptText(target, `${MONGODB_SETUP}auth mongosh "$DB" --quiet --eval 'db.dropDatabase()'`)
  },
  async importSchema (_target, sql) {
    for await (const chunk of sql) {
      void chunk
    }
  },
  async importTable (target, table, sql, replace) {
    await scriptInput(
      target,
      `${MONGODB_SETUP}auth mongorestore --quiet --archive --nsInclude "*.$1" --nsFrom "\\$db\\$.$1" --nsTo "$DB.$1"${replace ? ' --drop' : ''}`,
      sql,
      [table]
    )
  },
  finish () {
    return Promise.resolve()
  },
  nativeMagic: GZIP_MAGIC,
  dumpNative (target) {
    return scriptOutput(target, `${MONGODB_SETUP}auth mongodump --quiet --archive --gzip --db "$DB"`)
  },
  async restoreNative (target, archive, tables) {
    await scriptInput(
      target,
      `${MONGODB_SETUP}auth mongorestore --quiet --archive --gzip --drop --nsFrom '$db$.$coll$' --nsTo "$DB"'.$coll$' "$@"`,
      archive,
      (tables ?? []).flatMap(table => ['--nsInclude', `*.${escapeNamespace(table)}`])
    )
  }
}

const ENGINES: Record<DatabaseEngineName, DatabaseEngine> = { postgres, mariadb, mongodb }

/**
 * Tells whether a name is a supported database engine.
 *
 * @param name - The name.
 * @returns True for a supported engine.
 */
export function isDatabaseEngineName (name: unknown): name is DatabaseEngineName {
  return typeof name === 'string' && Object.hasOwn(ENGINES, name)
}

/**
 * Gives the operations of a database engine.
 *
 * @param name - The engine.
 * @returns Its operations.
 */
export function databaseEngine (name: DatabaseEngineName): DatabaseEngine {
  return ENGINES[name]
}
