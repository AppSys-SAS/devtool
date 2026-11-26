import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
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
  /** Lists the tables of the database holding rows, as identifiers usable in SQL. */
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
  /** Dumps the whole database in the archive format of the engine's own tools. */
  dumpNative(target: DatabaseTarget): AsyncIterable<Buffer>
  /**
   * Replaces the database, or the rows of some of its tables, each having to be in the archive, by an
   * archive file of the engine's own tools. The archive is sent whole to the container before
   * anything changes, and an archive the engine refuses leaves the database as it was.
   */
  restoreNative(target: DatabaseTarget, archivePath: string, tables: string[] | null): Promise<void>
}

const STDERR_TAIL_BYTES = 4096
const MONGODUMP_MAGIC = Buffer.from([0x6d, 0xe2, 0x99, 0x81])
const MONGODUMP_TERMINATOR = -1
const BSON_MIN_DOCUMENT_BYTES = 5
const BSON_MAX_DOCUMENT_BYTES = 16 * 1024 * 1024 + 16 * 1024
const SQL_LINE_HEAD_BYTES = 64
const SQL_DATABASE_STATEMENT = /^\s*(?:\/\*!\d+\s+)?(?:USE[\s`]|(?:CREATE|DROP)\s+DATABASE\b)/i
const SQL_DELIMITER_LINE = /^DELIMITER\s+(\S+)/i

/**
 * Beginning of the scripts restoring an archive, after the setup of their engine: the archive is
 * read on the standard input into the file `$ARCHIVE`, removed at exit by `cleanup`, and the script
 * stops before changing anything unless the file holds the number of bytes given as first argument.
 */
const RECEIVE_ARCHIVE = `ARCHIVE=$(mktemp)
cleanup() { rm -f "$ARCHIVE"; }
trap cleanup EXIT
cat > "$ARCHIVE"
[ "$(wc -c < "$ARCHIVE")" -eq "$1" ] || { echo "the archive was not received whole: nothing was changed" >&2; exit 1; }
shift
`

/**
 * Script line setting `$SUFFIX` to 16 random hexadecimal digits, naming the databases a script
 * creates for itself.
 */
const UNIQUE_SUFFIX = `SUFFIX=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n')
`

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
 * Uncompresses a gzip-compressed archive, failing with a message naming the expected format when
 * the archive is not one, or is cut.
 *
 * @param archive - The archive.
 * @returns Its uncompressed bytes.
 */
async function* gunzipped (archive: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  try {
    yield* transformed(archive, createGunzip())
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('Z_')) {
      throw new Error(`not a complete gzip-compressed archive (${error.message})`, { cause: error })
    }
    throw error
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
 * Reads a whole SQL dump of one database, failing when a statement of the dump selects, creates or
 * drops a database: such a dump, as `--databases` makes, loads elsewhere than in the database it is
 * restored into. The bodies of routines, triggers and events, written between `DELIMITER` lines, are
 * not read, their lines being no statements of the dump. It guards against that mistake of the one
 * dumping, not against what the statements of a dump written by hand may do.
 *
 * @param sql - The dump, each statement starting a line.
 * @returns The size of the dump, in bytes.
 */
export async function assertDatabaseLessDump (sql: AsyncIterable<Buffer>): Promise<number> {
  let inBody = false
  const judge = (lineHead: string): void => {
    const delimiter = SQL_DELIMITER_LINE.exec(lineHead)
    if (delimiter) {
      inBody = delimiter[1] !== ';'
    } else if (!inBody && SQL_DATABASE_STATEMENT.test(lineHead)) {
      throw new Error(`the dump names its own database (${lineHead.trim().slice(0, 40)}): dump one database, without --databases`)
    }
  }
  let size = 0
  let pending: Buffer = Buffer.alloc(0)
  let midLine = false
  for await (const chunk of sql) {
    if (chunk.length === 0) {
      continue
    }
    size += chunk.length
    let data = chunk
    let lineStart = 0
    if (pending.length > 0) {
      data = Buffer.concat([pending, chunk])
      pending = Buffer.alloc(0)
    } else if (midLine) {
      const newline = data.indexOf(10)
      lineStart = newline < 0 ? data.length : newline + 1
    }
    while (lineStart < data.length) {
      const newline = data.indexOf(10, lineStart)
      const end = newline < 0 ? data.length : newline
      if (newline < 0 && end - lineStart < SQL_LINE_HEAD_BYTES) {
        pending = Buffer.from(data.subarray(lineStart))
        break
      }
      judge(data.toString('latin1', lineStart, Math.min(end, lineStart + SQL_LINE_HEAD_BYTES)))
      lineStart = end + 1
    }
    midLine = pending.length === 0 && data.length > 0 && data[data.length - 1] !== 10
  }
  judge(pending.toString('latin1'))
  return size
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

/**
 * Prefix of the PostgreSQL scripts: `$DB`, the database, and `$CONN`, the connection string naming it
 * literally, whatever characters it holds.
 */
const POSTGRES_SETUP = `: "\${POSTGRES_USER:=postgres}"
: "\${POSTGRES_DB:=$POSTGRES_USER}"
${databaseSetup('POSTGRES_DB')}CONN="dbname='$(printf '%s' "$DB" | sed "s/[\\\\\\\\']/\\\\\\\\&/g")'"
`
const POSTGRES_CLIENT = 'psql -U "$POSTGRES_USER" -d "$CONN" -X -q -v ON_ERROR_STOP=1'

/**
 * Builds the statements setting the sequences owned by tables, or by the tables they inherit from or
 * are partitions of, just after their highest value.
 *
 * @param tables - The tables, as `schema.table` identifiers, or null for every table of the database.
 * @returns The SQL.
 */
function postgresSequencesSql (tables: string[] | null): string {
  const names = tables?.map(table => `'${table.replaceAll('\'', '\'\'')}'`).join(', ')
  const selected = tables === null
    ? ''
    : ` AND a.attrelid IN (WITH RECURSIVE lineage(rel) AS (SELECT unnest(ARRAY[${names}]::regclass[])::oid UNION SELECT i.inhparent FROM pg_inherits i JOIN lineage l ON i.inhrelid = l.rel) SELECT rel FROM lineage)`
  return `DO $adt$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT a.attrelid::regclass AS rel, a.attname, pg_get_serial_sequence(a.attrelid::regclass::text, a.attname) AS seq
    FROM pg_attribute a
    JOIN pg_class r ON r.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE r.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped AND n.nspname NOT IN ('pg_catalog', 'information_schema')${selected}
  LOOP
    IF c.seq IS NOT NULL THEN
      EXECUTE format('SELECT setval(%L, coalesce((SELECT max(%I) FROM %s), 0) + 1, false)', c.seq, c.attname, c.rel);
    END IF;
  END LOOP;
END $adt$;
`
}

/**
 * Replaces the database by the received `pg_dump -Fc` archive: the archive is restored into a new
 * database of a name no database has, which takes the place of the database once wholly restored,
 * in one transaction; a refused archive leaves the database as it was. The script fails, naming it,
 * when the former database cannot be dropped once replaced.
 */
const POSTGRES_WHOLE_RESTORE = `set -e
export PGOPTIONS="-c client_min_messages=warning"
${UNIQUE_SUFFIX}STAGING="adt_staging_$SUFFIX"
REPLACED="adt_replaced_$SUFFIX"
created=
cleanup() {
  rm -f "$ARCHIVE"
  [ -z "$created" ] || dropdb -U "$POSTGRES_USER" --force --if-exists "$STAGING" || true
}
createdb -U "$POSTGRES_USER" "$STAGING"
created=1
pg_restore -U "$POSTGRES_USER" -d "dbname='$STAGING'" --no-owner --no-privileges --exit-on-error "$ARCHIVE"
psql -U "$POSTGRES_USER" -d template1 -X -q -v ON_ERROR_STOP=1 -v staging="$STAGING" -v target="$DB" -v replaced="$REPLACED" -1 <<'SQL'
SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target') AS present \\gset
\\if :present
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'target' AND pid <> pg_backend_pid() \\g /dev/null
ALTER DATABASE :"target" RENAME TO :"replaced";
\\endif
ALTER DATABASE :"staging" RENAME TO :"target";
SQL
created=
dropdb -U "$POSTGRES_USER" --force --if-exists "$REPLACED" || {
  echo "the database was restored, but its former copy $REPLACED could not be dropped: drop it by hand" >&2
  exit 1
}
`

/**
 * Replaces the rows of some tables by those of the received `pg_dump -Fc` archive, in one
 * transaction, foreign keys unchecked: `$1` empties the tables, `$2` runs once their rows are loaded,
 * then each pair of arguments names the schema and the table of an archive entry, which must exist.
 */
const POSTGRES_PARTIAL_RESTORE = `set -e
work=$(mktemp -d)
cleanup() { rm -rf "$ARCHIVE" "$work"; }
pg_restore -l "$ARCHIVE" > /dev/null
before="$1"; after="$2"; shift 2
: > "$work/list"
while [ $# -gt 0 ]; do
  pg_restore -l -n "$1" -t "$2" "$ARCHIVE" | grep -E '^[0-9]+; [0-9]+ [0-9]+ TABLE DATA ' > "$work/entry" || true
  [ -s "$work/entry" ] || { echo "$1.$2 is not in the archive" >&2; exit 1; }
  cat "$work/entry" >> "$work/list"
  shift 2
done
pg_restore --data-only -L "$work/list" -f "$work/data.sql" "$ARCHIVE"
{ printf 'SET session_replication_role = replica;\\n%s\\n' "$before"; cat "$work/data.sql"; printf '\\n%s\\n' "$after"; } | ${POSTGRES_CLIENT} -1
`

/** PostgreSQL of the official image: local socket, credentials from the container environment. */
const postgres: DatabaseEngine = {
  async listTables (target) {
    const text = await scriptText(
      target,
      `${POSTGRES_SETUP}${POSTGRES_CLIENT} -At -c "SELECT format('%I.%I', n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1"`
    )
    return text.split('\n').filter(line => line !== '')
  },
  dumpSchema (target) {
    return scriptOutput(target, `${POSTGRES_SETUP}pg_dump -U "$POSTGRES_USER" --schema-only --no-owner --no-privileges -d "$CONN"`)
  },
  dumpTable (target, table) {
    return scriptOutput(target, `${POSTGRES_SETUP}pg_dump -U "$POSTGRES_USER" --data-only --no-owner --no-privileges -t "$1" -d "$CONN"`, [table])
  },
  async reset (target) {
    await scriptText(target, `${POSTGRES_SETUP}dropdb -U "$POSTGRES_USER" --force --if-exists "$DB" && createdb -U "$POSTGRES_USER" "$DB"`)
  },
  async importSchema (target, sql) {
    await scriptInput(target, `${POSTGRES_SETUP}${POSTGRES_CLIENT}`, sql)
  },
  async importTable (target, table, sql, replace) {
    const preamble = `SET session_replication_role = replica;\n${replace ? `DELETE FROM ONLY ${table};\n` : ''}`
    await scriptInput(target, `${POSTGRES_SETUP}${POSTGRES_CLIENT}`, prefixed(preamble, sql))
  },
  async finish (target) {
    await scriptInput(target, `${POSTGRES_SETUP}${POSTGRES_CLIENT}`, textStream(postgresSequencesSql(null)))
  },
  dumpNative (target) {
    return scriptOutput(target, `${POSTGRES_SETUP}pg_dump -U "$POSTGRES_USER" -Fc -d "$CONN"`)
  },
  async restoreNative (target, archivePath, tables) {
    const { size } = await stat(archivePath)
    if (tables === null) {
      await scriptInput(target, `${POSTGRES_SETUP}${RECEIVE_ARCHIVE}${POSTGRES_WHOLE_RESTORE}`, createReadStream(archivePath), [String(size)])
      return
    }

    const empty = tables.map(table => `DELETE FROM ONLY ${table};`).join(' ')
    const selection = tables.flatMap(table => {
      const { schema, table: name } = splitPostgresName(table)
      return [schema, name]
    })
    await scriptInput(
      target,
      `${POSTGRES_SETUP}${RECEIVE_ARCHIVE}${POSTGRES_PARTIAL_RESTORE}`,
      createReadStream(archivePath),
      [String(size), empty, postgresSequencesSql(tables), ...selection]
    )
  }
}

/**
 * Prefix of the MariaDB scripts: `$DB`, the database, the root password, `empty`, dropping the
 * database and creating it again without table, with the options of `CREATE DATABASE` given as
 * argument, and `grant`, giving the account of the container, when it declares one, every privilege
 * on the database.
 */
const MARIADB_SETUP = `${databaseSetup('MARIADB_DATABASE')}export MYSQL_PWD="$MARIADB_ROOT_PASSWORD"
QUOTED=$(printf '%s' "$DB" | sed 's/\`/\`\`/g')
empty() {
  mariadb -uroot -e "DROP DATABASE IF EXISTS \\\`$QUOTED\\\`; CREATE DATABASE \\\`$QUOTED\\\`$1"
}
grant() {
  [ -z "$MARIADB_USER" ] || mariadb -uroot -e "GRANT ALL PRIVILEGES ON \\\`$QUOTED\\\`.* TO '$MARIADB_USER'@'%'"
}
`

/**
 * Replaces the database by the received SQL dump, keeping its character set and collation: the
 * database is saved first, and put back when the server refuses a step of the restore. Its saved
 * dump is kept in the container when it cannot be put back.
 */
const MARIADB_WHOLE_RESTORE = `saved=$(mktemp)
cleanup() { rm -f "$ARCHIVE" "$saved"; }
existed=
options=
if found=$(mariadb -uroot -N -B -e "USE \\\`$QUOTED\\\`; SELECT @@character_set_database, @@collation_database" 2> "$saved"); then
  existed=1
  options=" CHARACTER SET $(printf '%s' "$found" | cut -f1) COLLATE $(printf '%s' "$found" | cut -f2)"
  mariadb-dump -uroot --single-transaction --routines --triggers --events "$DB" > "$saved" || {
    echo "the database could not be saved before its restore, so nothing was changed: repair it, or drop it to restore the archive into a new database" >&2
    exit 1
  }
elif ! grep -q '^ERROR 1049 ' "$saved"; then
  cat "$saved" >&2
  echo "the server could not tell whether the database exists: nothing was changed" >&2
  exit 1
fi
empty "$options" && grant && mariadb -uroot "$DB" < "$ARCHIVE" && exit 0
if [ -z "$existed" ]; then
  mariadb -uroot -e "DROP DATABASE IF EXISTS \\\`$QUOTED\\\`" && echo "the restore was refused: the database, which did not exist, was removed" >&2
elif empty "$options" && mariadb -uroot "$DB" < "$saved"; then
  echo "the restore was refused: the database was put back as it was" >&2
else
  cleanup() { rm -f "$ARCHIVE"; }
  echo "the restore was refused and the database could not be put back: its dump is kept in the container, in $saved" >&2
fi
exit 1
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
    await scriptText(target, `${MARIADB_SETUP}empty && grant`)
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
  dumpNative (target) {
    return transformed(scriptOutput(target, `${MARIADB_SETUP}mariadb-dump -uroot --single-transaction --routines --triggers --events "$DB"`), createGzip())
  },
  async restoreNative (target, archivePath, tables) {
    if (tables !== null) {
      throw new Error('a native mariadb archive is a SQL script: it restores the whole database only')
    }
    const dump = (): AsyncIterable<Buffer> => gunzipped(createReadStream(archivePath))
    const size = await assertDatabaseLessDump(dump())
    await scriptInput(target, `${MARIADB_SETUP}${RECEIVE_ARCHIVE}${MARIADB_WHOLE_RESTORE}`, dump(), [String(size)])
  }
}

/**
 * Prefix of the MongoDB scripts: `$DB`, the database, exported for the scripts of the MongoDB shell,
 * and `auth`, running a MongoDB tool with the root credentials of the container when it declares some.
 */
const MONGODB_SETUP = `${databaseSetup('MONGO_INITDB_DATABASE')}export DB
auth() {
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
 * Reads the string fields at the top level of a BSON document.
 *
 * @param document - The document.
 * @returns The values of its string fields, by name.
 */
function bsonStrings (document: Buffer): Map<string, string> {
  const fixedSizes: Record<number, number> = { 0x01: 8, 0x07: 12, 0x08: 1, 0x09: 8, 0x0a: 0, 0x10: 4, 0x11: 8, 0x12: 8, 0x13: 16 }
  const fields = new Map<string, string>()
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
 * Reads the collections listed in the prelude of an archive of `mongodump --archive --gzip`: its
 * magic number, a header document, then one document per collection up to a -1 terminator.
 *
 * @param archive - The archive.
 * @returns The collections, with the database they were dumped from.
 */
async function mongodumpNamespaces (archive: AsyncIterable<Buffer>): Promise<MongoNamespace[]> {
  const namespaces: MongoNamespace[] = []
  let buffer: Buffer = Buffer.alloc(0)
  let started = false
  let documents = 0
  for await (const chunk of gunzipped(archive)) {
    buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : chunk
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
        if (documents === 0) {
          throw new Error('not a mongodump archive: no header')
        }
        return namespaces
      }
      if (size < BSON_MIN_DOCUMENT_BYTES || size > BSON_MAX_DOCUMENT_BYTES) {
        throw new Error('not a mongodump archive: one of its documents is corrupted')
      }
      if (buffer.length < size) {
        break
      }
      const fields = bsonStrings(buffer.subarray(0, size))
      const db = fields.get('db')
      const collection = fields.get('collection')
      if (documents > 0 && db !== undefined && collection !== undefined) {
        namespaces.push({ db, collection })
      }
      documents += 1
      buffer = buffer.subarray(size)
    }
  }
  throw new Error('not a mongodump archive: no complete list of collections')
}

/**
 * Dumps the database as an archive of `mongodump --archive --gzip`, failing for a database without
 * collection, which the tool would dump as an empty archive.
 */
const MONGODB_DUMP = `count=$(auth mongosh --quiet --eval 'print(db.getSiblingDB(process.env.DB).getCollectionNames().length)') || exit 1
[ "$count" -gt 0 ] || { echo "the database $DB has no collection: there is nothing to dump" >&2; exit 1; }
auth mongodump --quiet --archive --gzip --db "$DB"
`

/**
 * Replaces the database, when `$1` is 1, or the collections the following arguments select, by the
 * received archive of `mongodump --archive --gzip`, whatever database it was dumped from: the archive
 * is first restored into a new database of a name no database has, dropped afterwards, and an
 * archive the engine refuses there leaves the database as it was.
 */
const MONGODB_RESTORE = `set -e
whole="$1"; shift
${UNIQUE_SUFFIX}export STAGING="adt_staging_$SUFFIX"
created=
drop() {
  auth mongosh --quiet --eval "db.getSiblingDB(process.env.$1).dropDatabase()" > /dev/null
}
cleanup() {
  rm -f "$ARCHIVE"
  [ -z "$created" ] || drop STAGING || true
}
restore_into() {
  into="$1"; shift
  auth mongorestore --archive="$ARCHIVE" --gzip --drop --nsFrom '$db$.$coll$' --nsTo "$into"'.$coll$' "$@"
}
auth mongosh --quiet --eval 'quit(db.getMongo().getDBNames().includes(process.env.STAGING) ? 1 : 0)' || {
  echo "the database $STAGING already exists: nothing was changed, try again" >&2
  exit 1
}
created=1
restore_into "$STAGING" "$@"
[ "$whole" = 0 ] || drop DB
restore_into "$DB" "$@"
`

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
      `${MONGODB_SETUP}auth mongosh --quiet --eval 'db.getSiblingDB(process.env.DB).getCollectionNames().filter((name) => !name.startsWith("system.")).sort().forEach((name) => print(name))'`
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
    await scriptText(target, `${MONGODB_SETUP}auth mongosh --quiet --eval 'db.getSiblingDB(process.env.DB).dropDatabase()'`)
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
  dumpNative (target) {
    return scriptOutput(target, `${MONGODB_SETUP}${MONGODB_DUMP}`)
  },
  async restoreNative (target, archivePath, tables) {
    const namespaces = await mongodumpNamespaces(createReadStream(archivePath))
    const sources = [...new Set(namespaces.map(namespace => namespace.db))]
    if (sources.length !== 1) {
      throw new Error(sources.length === 0 ? 'the archive holds no collection' : `the archive holds several databases (${sources.join(', ')}): dump one, with --db`)
    }
    const missing = (tables ?? []).filter(table => !namespaces.some(namespace => namespace.collection === table))
    if (missing.length > 0) {
      throw new Error(`not in the archive: ${missing.join(', ')}`)
    }
    const selection = namespaces
      .filter(namespace => tables?.includes(namespace.collection) === true)
      .flatMap(namespace => ['--nsInclude', `${escapeNamespace(namespace.db)}.${escapeNamespace(namespace.collection)}`])

    const { size } = await stat(archivePath)
    await scriptInput(
      target,
      `${MONGODB_SETUP}${RECEIVE_ARCHIVE}${MONGODB_RESTORE}`,
      createReadStream(archivePath),
      [String(size), tables === null ? '1' : '0', ...selection]
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
