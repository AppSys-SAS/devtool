import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Database engines a local container can run. */
export type DatabaseEngineName = 'postgres' | 'mariadb' | 'mongodb'

/** Dump and restore operations of a database engine, run inside its container. */
export interface DatabaseEngine {
  /** Lists the tables of the database, as identifiers usable in SQL. */
  listTables(container: string): Promise<string[]>
  /** Dumps the schema of the database, without data. */
  dumpSchema(container: string): AsyncIterable<Buffer>
  /** Dumps the rows of a table, without its definition. */
  dumpTable(container: string, table: string): AsyncIterable<Buffer>
  /** Drops and recreates the database, empty. */
  reset(container: string): Promise<void>
  /** Runs a schema dump. */
  importSchema(container: string, sql: AsyncIterable<Buffer>): Promise<void>
  /** Loads the rows of a table, foreign keys unchecked, emptying the table first when asked. */
  importTable(container: string, table: string, sql: AsyncIterable<Buffer>, replace: boolean): Promise<void>
  /** Brings what depends on loaded rows, such as sequences, in line with them. */
  finish(container: string): Promise<void>
}

const STDERR_TAIL_BYTES = 4096

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
 * Runs a shell script in a container, streaming its output.
 *
 * @param container - The container.
 * @param script - The script, reading its arguments as `$1`, `$2`...
 * @param args - The arguments of the script.
 * @returns The output, failing at its end when the script failed.
 */
async function* scriptOutput (container: string, script: string, args: string[] = []): AsyncGenerator<Buffer> {
  const child = spawn('docker', ['exec', container, 'sh', '-c', script, 'sh', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  const errors = collectErrors(child)
  const exited = assertExit(child, errors, `docker exec ${container}`)
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
 * @param container - The container.
 * @param script - The script.
 * @returns The output text.
 */
async function scriptText (container: string, script: string): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of scriptOutput(container, script)) {
    chunks.push(chunk)
  }

  return Buffer.concat(chunks).toString('utf-8')
}

/**
 * Runs a shell script in a container with an input.
 *
 * @param container - The container.
 * @param script - The script, reading its arguments as `$1`, `$2`...
 * @param input - The standard input of the script.
 * @param args - The arguments of the script.
 */
async function scriptInput (container: string, script: string, input: AsyncIterable<Buffer>, args: string[] = []): Promise<void> {
  const child = spawn('docker', ['exec', '-i', container, 'sh', '-c', script, 'sh', ...args], { stdio: ['pipe', 'ignore', 'pipe'] })
  const errors = collectErrors(child)
  const piped = pipeline(Readable.from(input), child.stdin).then(() => null, (error: unknown) => (error instanceof Error ? error : new Error(String(error))))
  await assertExit(child, errors, `docker exec ${container}`)
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

const POSTGRES_CLIENT = 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -v ON_ERROR_STOP=1'
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

/** PostgreSQL of the official image: local socket, credentials from the container environment. */
const postgres: DatabaseEngine = {
  async listTables (container) {
    const text = await scriptText(
      container,
      `${POSTGRES_CLIENT} -At -c "SELECT format('%I.%I', schemaname, tablename) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1"`
    )
    return text.split('\n').filter(line => line !== '')
  },
  dumpSchema (container) {
    return scriptOutput(container, 'pg_dump -U "$POSTGRES_USER" --schema-only --no-owner --no-privileges "$POSTGRES_DB"')
  },
  dumpTable (container, table) {
    return scriptOutput(container, 'pg_dump -U "$POSTGRES_USER" --data-only --no-owner --no-privileges -t "$1" "$POSTGRES_DB"', [table])
  },
  async reset (container) {
    await scriptText(container, 'dropdb -U "$POSTGRES_USER" --force --if-exists "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"')
  },
  async importSchema (container, sql) {
    await scriptInput(container, POSTGRES_CLIENT, sql)
  },
  async importTable (container, table, sql, replace) {
    const preamble = `SET session_replication_role = replica;\n${replace ? `DELETE FROM ${table};\n` : ''}`
    await scriptInput(container, POSTGRES_CLIENT, prefixed(preamble, sql))
  },
  async finish (container) {
    await scriptInput(container, POSTGRES_CLIENT, textStream(POSTGRES_SEQUENCES_SQL))
  }
}

const MARIADB_ROOT = 'export MYSQL_PWD="$MARIADB_ROOT_PASSWORD";'

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
  async listTables (container) {
    const text = await scriptText(container, `${MARIADB_ROOT} mariadb -uroot -N -B -e "SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'" "$MARIADB_DATABASE"`)
    return text
      .split('\n')
      .filter(line => line !== '')
      .map(line => line.split('\t')[0])
  },
  dumpSchema (container) {
    return scriptOutput(container, `${MARIADB_ROOT} mariadb-dump -uroot --no-data --routines --triggers --events --skip-comments "$MARIADB_DATABASE"`)
  },
  dumpTable (container, table) {
    return scriptOutput(
      container,
      `${MARIADB_ROOT} mariadb-dump -uroot --no-create-info --skip-triggers --skip-comments --single-transaction "$MARIADB_DATABASE" "$1"`,
      [table]
    )
  },
  async reset (container) {
    await scriptText(
      container,
      `${MARIADB_ROOT} mariadb -uroot -e "DROP DATABASE IF EXISTS \\\`$MARIADB_DATABASE\\\`; CREATE DATABASE \\\`$MARIADB_DATABASE\\\`; GRANT ALL PRIVILEGES ON \\\`$MARIADB_DATABASE\\\`.* TO '$MARIADB_USER'@'%'"`
    )
  },
  async importSchema (container, sql) {
    await scriptInput(container, `${MARIADB_ROOT} mariadb -uroot "$MARIADB_DATABASE"`, sql)
  },
  async importTable (container, table, sql, replace) {
    const preamble = `SET FOREIGN_KEY_CHECKS = 0;\n${replace ? `DELETE FROM ${quoteMariadb(table)};\n` : ''}`
    await scriptInput(container, `${MARIADB_ROOT} mariadb -uroot "$MARIADB_DATABASE"`, prefixed(preamble, sql))
  },
  finish () {
    return Promise.resolve()
  }
}

/**
 * Prefix of the MongoDB scripts: `$DB`, the database of the container, and `auth`, running a MongoDB
 * tool with the root credentials of the container when it declares some.
 */
const MONGODB_SETUP = `DB="$MONGO_INITDB_DATABASE"
[ -n "$DB" ] || { echo "MONGO_INITDB_DATABASE is not set in the container" >&2; exit 1; }
auth() {
  if [ -n "$MONGO_INITDB_ROOT_USERNAME" ]; then
    "$@" --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin
  else
    "$@"
  fi
}
`

/**
 * Gives an empty stream.
 *
 * @returns A stream without chunk.
 */
function emptyStream (): AsyncIterable<Buffer> {
  return Readable.from([])
}

/** MongoDB of the official image: collections as tables, the database and credentials from the container environment. */
const mongodb: DatabaseEngine = {
  async listTables (container) {
    const text = await scriptText(
      container,
      `${MONGODB_SETUP}auth mongosh "$DB" --quiet --eval 'db.getCollectionNames().filter((name) => !name.startsWith("system.")).sort().forEach((name) => print(name))'`
    )
    return text.split('\n').filter(line => line !== '')
  },
  dumpSchema () {
    return emptyStream()
  },
  dumpTable (container, table) {
    return scriptOutput(container, `${MONGODB_SETUP}auth mongodump --quiet --archive --db "$DB" --collection "$1"`, [table])
  },
  async reset (container) {
    await scriptText(container, `${MONGODB_SETUP}auth mongosh "$DB" --quiet --eval 'db.dropDatabase()'`)
  },
  async importSchema (_container, sql) {
    for await (const chunk of sql) {
      void chunk
    }
  },
  async importTable (container, table, sql, replace) {
    await scriptInput(
      container,
      `${MONGODB_SETUP}auth mongorestore --quiet --archive --nsInclude "*.$1" --nsFrom "\\$db\\$.$1" --nsTo "$DB.$1"${replace ? ' --drop' : ''}`,
      sql,
      [table]
    )
  },
  finish () {
    return Promise.resolve()
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
