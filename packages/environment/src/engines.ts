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
  /** Whether the archives of the engine's own tools are gzip-compressed. */
  readonly nativeGzipped: boolean
  /** Tells whether the first bytes of an archive, once uncompressed, are those of an archive of the engine's own tools. */
  isNativeHead(head: Buffer): boolean
  /** Reads a whole archive of the engine's own tools without writing anything, failing when it is truncated or corrupted. */
  checkNative(target: DatabaseTarget, archive: AsyncIterable<Buffer>): Promise<void>
  /** Dumps the whole database in the archive format of the engine's own tools. */
  dumpNative(target: DatabaseTarget): AsyncIterable<Buffer>
  /**
   * Loads an archive of the engine's own tools: every table into an emptied database, or the rows of
   * some tables, replaced, each having to be in the archive. `archive` opens the archive, once per read.
   */
  restoreNative(target: DatabaseTarget, archive: () => AsyncIterable<Buffer>, tables: string[] | null): Promise<void>
}

const STDERR_TAIL_BYTES = 4096
const PG_DUMP_MAGIC = Buffer.from('PGDMP')
const MONGODUMP_MAGIC = Buffer.from([0x6d, 0xe2, 0x99, 0x81])
const MONGODUMP_TERMINATOR = -1
const BSON_MIN_DOCUMENT_BYTES = 5
const SQL_SCRIPT_STARTS = ['--', '/*']

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
 * Uncompresses a whole gzip stream, which fails when the stream is truncated or corrupted.
 *
 * @param archive - The gzip stream.
 */
async function uncompressWhole (archive: AsyncIterable<Buffer>): Promise<void> {
  for await (const chunk of transformed(archive, createGunzip())) {
    void chunk
  }
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
: "\${POSTGRES_DB:=$POSTGRES_USER}"
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
pg_restore -l "$work/archive" > /dev/null
empty="$1"; shift
: > "$work/list"
while [ $# -gt 0 ]; do
  pg_restore -l -n "$1" -t "$2" "$work/archive" | grep -E '^[0-9]+; [0-9]+ [0-9]+ TABLE DATA ' > "$work/entry" || true
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
  nativeGzipped: false,
  isNativeHead (head) {
    return head.subarray(0, PG_DUMP_MAGIC.length).equals(PG_DUMP_MAGIC)
  },
  async checkNative (target, archive) {
    await scriptInput(target, `${POSTGRES_SETUP}pg_restore -f /dev/null`, archive)
  },
  dumpNative (target) {
    return scriptOutput(target, `${POSTGRES_SETUP}pg_dump -U "$POSTGRES_USER" -Fc "$DB"`)
  },
  async restoreNative (target, archive, tables) {
    if (tables === null) {
      await scriptInput(target, `${POSTGRES_SETUP}pg_restore -U "$POSTGRES_USER" -d "$DB" --no-owner --no-privileges --exit-on-error`, archive())
      return
    }

    const empty = tables.map(table => `DELETE FROM ${table};`).join(' ')
    const selection = tables.flatMap(table => {
      const { schema, table: name } = splitPostgresName(table)
      return [schema, name]
    })
    await scriptInput(target, `${POSTGRES_SETUP}${POSTGRES_PARTIAL_RESTORE}`, archive(), [empty, ...selection])
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
      `${MARIADB_SETUP}QUOTED=$(printf '%s' "$DB" | sed 's/\`/\`\`/g')
mariadb -uroot -e "DROP DATABASE IF EXISTS \\\`$QUOTED\\\`; CREATE DATABASE \\\`$QUOTED\\\`;\${MARIADB_USER:+ GRANT ALL PRIVILEGES ON \\\`$QUOTED\\\`.* TO '$MARIADB_USER'@'%'}"`
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
  nativeGzipped: true,
  isNativeHead (head) {
    const text = head.toString('utf-8').trimStart()
    return !head.includes(0) && SQL_SCRIPT_STARTS.some(start => text.startsWith(start))
  },
  checkNative (_target, archive) {
    return uncompressWhole(archive)
  },
  dumpNative (target) {
    return transformed(scriptOutput(target, `${MARIADB_SETUP}mariadb-dump -uroot --single-transaction --routines --triggers --events "$DB"`), createGzip())
  },
  async restoreNative (target, archive, tables) {
    if (tables !== null) {
      throw new Error('a native mariadb archive is a SQL script: it restores the whole database only')
    }
    await scriptInput(target, `${MARIADB_SETUP}mariadb -uroot "$DB"`, transformed(archive(), createGunzip()))
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
 * @param name - A database or collection name.
 * @returns The name, matching itself only.
 */
function escapeNamespace (name: string): string {
  return name.replace(/[\\*]/g, '\\$&')
}

/** A collection of a database. */
interface MongoNamespace {
  db: string
  collection: string
}

/**
 * Reads the string and boolean fields at the top level of a BSON document.
 *
 * @param document - The document.
 * @returns The values of its string and boolean fields, by name.
 */
function bsonFields (document: Buffer): Map<string, string | boolean> {
  const fixedSizes: Record<number, number> = { 0x01: 8, 0x07: 12, 0x09: 8, 0x0a: 0, 0x10: 4, 0x11: 8, 0x12: 8, 0x13: 16 }
  const fields = new Map<string, string | boolean>()
  const lengthAt = (at: number, minimum: number, prefix: number): number => {
    const length = at + 4 <= document.length ? document.readInt32LE(at) : -1
    if (length < minimum || at + prefix + length > document.length) {
      throw new Error('not a mongodump archive: one of its documents is corrupted')
    }
    return length
  }
  let offset = 4
  while (offset < document.length - 1) {
    const type = document[offset]
    const nameEnd = document.indexOf(0, offset + 1)
    if (nameEnd < 0) {
      break
    }
    const name = document.toString('utf-8', offset + 1, nameEnd)
    offset = nameEnd + 1
    if (type === 0x02) {
      const length = lengthAt(offset, 1, 4)
      fields.set(name, document.toString('utf-8', offset + 4, offset + 4 + length - 1))
      offset += 4 + length
    } else if (type === 0x08) {
      fields.set(name, document[offset] === 1)
      offset += 1
    } else if (type === 0x03 || type === 0x04) {
      offset += lengthAt(offset, BSON_MIN_DOCUMENT_BYTES, 0)
    } else if (type === 0x05) {
      offset += 5 + lengthAt(offset, 0, 5)
    } else if (type in fixedSizes) {
      offset += fixedSizes[type]
    } else {
      break
    }
  }
  return fields
}

/**
 * Reads the records of an archive of `mongodump --archive --gzip`, after its magic number: BSON
 * documents, and null for each -1 terminator ending a list of documents.
 *
 * @param archive - The archive.
 * @returns The records, in their order in the archive.
 */
async function* mongodumpRecords (archive: AsyncIterable<Buffer>): AsyncGenerator<Buffer | null> {
  let buffer: Buffer = Buffer.alloc(0)
  let started = false
  for await (const chunk of transformed(archive, createGunzip())) {
    buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk as Buffer]) : chunk as Buffer
    if (!started) {
      if (buffer.length < MONGODUMP_MAGIC.length) {
        continue
      }
      if (!buffer.subarray(0, MONGODUMP_MAGIC.length).equals(MONGODUMP_MAGIC)) {
        throw new Error('not a mongodump archive')
      }
      buffer = buffer.subarray(MONGODUMP_MAGIC.length)
      started = true
    }
    while (buffer.length >= 4) {
      const size = buffer.readInt32LE(0)
      if (size === MONGODUMP_TERMINATOR) {
        buffer = buffer.subarray(4)
        yield null
        continue
      }
      if (size < BSON_MIN_DOCUMENT_BYTES) {
        throw new Error('not a mongodump archive: one of its documents is corrupted')
      }
      if (buffer.length < size) {
        break
      }
      const document = buffer.subarray(0, size)
      buffer = buffer.subarray(size)
      yield document
    }
  }
  if (!started || buffer.length > 0) {
    throw new Error('not a mongodump archive: it ends in the middle of a document')
  }
}

/**
 * Reads the collections listed in the prelude of a mongodump archive: a header document, then one
 * document per collection up to a terminator.
 *
 * @param records - The records of the archive, read up to the end of the prelude.
 * @returns The collections, with the database they were dumped from.
 */
async function readPrelude (records: AsyncIterator<Buffer | null>): Promise<MongoNamespace[]> {
  const namespaces: MongoNamespace[] = []
  for (let index = 0; ; index += 1) {
    const record = await records.next()
    if (record.done) {
      throw new Error('not a mongodump archive: no complete list of collections')
    }
    if (record.value === null && index === 0) {
      throw new Error('not a mongodump archive: no header')
    }
    if (record.value === null) {
      return namespaces
    }
    const fields = bsonFields(record.value)
    const db = fields.get('db')
    const collection = fields.get('collection')
    if (index > 0 && typeof db === 'string' && typeof collection === 'string') {
      namespaces.push({ db, collection })
    }
  }
}

/**
 * Reads the collections listed in the prelude of an archive of `mongodump --archive --gzip`.
 *
 * @param archive - The archive.
 * @returns The collections, with the database they were dumped from.
 */
async function mongodumpNamespaces (archive: AsyncIterable<Buffer>): Promise<MongoNamespace[]> {
  const records = mongodumpRecords(archive)
  try {
    return await readPrelude(records)
  } finally {
    await records.return(undefined)
  }
}

/**
 * Reads a whole archive of `mongodump --archive --gzip`, failing unless every collection of its
 * prelude reaches its end-of-file segment and the archive ends between two segments.
 *
 * @param archive - The archive.
 */
async function checkMongodump (archive: AsyncIterable<Buffer>): Promise<void> {
  const records = mongodumpRecords(archive)
  const pending = new Set((await readPrelude(records)).map(namespace => `${namespace.db}.${namespace.collection}`))
  let inSegment = false
  for await (const record of { [Symbol.asyncIterator]: () => records }) {
    if (record === null) {
      inSegment = false
    } else if (!inSegment) {
      const fields = bsonFields(record)
      if (fields.get('EOF') === true) {
        pending.delete(`${String(fields.get('db'))}.${String(fields.get('collection'))}`)
      }
      inSegment = true
    }
  }
  if (inSegment || pending.size > 0) {
    throw new Error(`not a complete mongodump archive: ${pending.size > 0 ? `${[...pending].join(', ')} never ends` : 'its last segment never ends'}`)
  }
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
  nativeGzipped: true,
  isNativeHead (head) {
    return head.subarray(0, MONGODUMP_MAGIC.length).equals(MONGODUMP_MAGIC)
  },
  checkNative (_target, archive) {
    return checkMongodump(archive)
  },
  dumpNative (target) {
    return scriptOutput(target, `${MONGODB_SETUP}auth mongodump --quiet --archive --gzip --db "$DB"`)
  },
  async restoreNative (target, archive, tables) {
    let selection: string[] = []
    if (tables !== null) {
      const namespaces = await mongodumpNamespaces(archive())
      const missing = tables.filter(table => !namespaces.some(namespace => namespace.collection === table))
      if (missing.length > 0) {
        throw new Error(`not in the archive: ${missing.join(', ')}`)
      }
      selection = namespaces
        .filter(namespace => tables.includes(namespace.collection))
        .flatMap(namespace => ['--nsInclude', `${escapeNamespace(namespace.db)}.${escapeNamespace(namespace.collection)}`])
    }
    await scriptInput(
      target,
      `${MONGODB_SETUP}auth mongorestore --quiet --archive --gzip --drop --nsFrom '$db$.$coll$' --nsTo "$DB"'.$coll$' "$@"`,
      archive(),
      selection
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
