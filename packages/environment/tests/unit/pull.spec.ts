import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArchiveWriter } from '../../src/archive.js'
import type { BackendContext, EnvironmentBackend, RemoteFile } from '../../src/backends/backend.js'
import { Environment, type EnvironmentItem } from '../../src/environment.js'
import { readSyncJournal, type SyncRecord, writeSyncRecord } from '../../src/sync-journal.js'

const UPDATED_AT = new Date('2026-01-01T00:00:00Z')
const ITEM_PATH = 'api/db.dump'
const PREVIOUS_RECORD: SyncRecord = { localUpdatedAt: new Date('2025-06-01T00:00:00Z'), remoteUpdatedAt: new Date('2025-06-01T00:00:00Z'), backend: 'team', remoteVersion: 'v1' }
const open = { backend: 'team', encryption: null, groups: { pull: null, push: null } }
const postgresItem: EnvironmentItem = { kind: 'database', path: ITEM_PATH, ...open, engine: 'postgres', container: 'db', database: null, format: 'native' }
const mariadbItem: EnvironmentItem = { ...postgresItem, engine: 'mariadb' }

let folder: string
let downloads: number
let downloadGate: Promise<void>

/**
 * Builds an environment of one item whose backend stores one archive, downloaded once
 * `downloadGate` resolves.
 * @param item - The item.
 * @param archive - The archive the backend stores.
 * @param listing - Lists the files of the backend.
 * @param cacheDir - The cache folder of the environment.
 * @returns The environment.
 */
function environmentOf (item: EnvironmentItem, archive: Buffer, listing?: () => Promise<RemoteFile[] | null>, cacheDir = folder): Environment {
  const backend: EnvironmentBackend = {
    list: listing ?? (async () => [{ path: item.path, size: archive.length, updatedAt: UPDATED_AT, version: 'v2' }]),
    download: async () => {
      downloads += 1
      await downloadGate
      return Readable.from([archive])
    },
    upload: async () => undefined,
    remove: async () => undefined,
    close: async () => undefined
  }
  const context: BackendContext = { resolve: async text => text, askSecret: async () => '', cacheDir, configFolder: folder, auth: null }
  const options = { folder: path.join(folder, 'env'), backends: [], defaultBackend: 'team', items: [item], configFiles: [], autoPulls: [], s3: null }
  return new Environment(new Map([['team', backend]]), options, context)
}

/**
 * Replaces the docker command by a shell script reading its standard input first.
 * @param body - What the script does once its input is read.
 */
async function fakeDocker (body: string): Promise<void> {
  await fs.writeFile(path.join(folder, 'bin', 'docker'), `#!/bin/sh\ncat > /dev/null\n${body}\n`, { mode: 0o755 })
}

/**
 * Reads what a pull left in the folder of the item: the names of its files and the content of its
 * local copy.
 * @returns The files and the local copy.
 */
async function localState (): Promise<{ files: string[], copy: string }> {
  const itemFolder = path.join(folder, 'env', 'api')
  return { files: await fs.readdir(itemFolder), copy: await fs.readFile(path.join(itemFolder, 'db.dump'), 'utf-8') }
}

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-pull-'))
  downloads = 0
  downloadGate = Promise.resolve()
  await fs.mkdir(path.join(folder, 'env', 'api'), { recursive: true })
  await fs.mkdir(path.join(folder, 'bin'))
  await fs.writeFile(path.join(folder, 'env', 'api', 'db.dump'), 'previous copy')
  await fakeDocker(`cat "${path.join(folder, 'env', 'api', 'db.dump')}" > "${path.join(folder, 'seen')}"`)
  vi.stubEnv('PATH', `${path.join(folder, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`)
  vi.stubEnv('ADT_CONFIG_FOLDER', folder)
  await writeSyncRecord(ITEM_PATH, PREVIOUS_RECORD)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fs.rm(folder, { recursive: true, force: true })
})

describe('pull of an item holding local data', () => {
  it('reads a whole devtool archive before touching the database, so a truncated one changes nothing', async () => {
    const item: EnvironmentItem = { ...postgresItem, format: 'devtool' }
    const archivePath = path.join(folder, 'whole.gz')
    const writer = new ArchiveWriter(archivePath)
    await writer.add({ type: 'database', engine: 'postgres' })
    await writer.add({ type: 'schema' }, Readable.from([Buffer.from('CREATE TABLE t (id int);\n')]))
    await writer.add({ type: 'table', name: 'public.t' }, Readable.from([Buffer.from('x'.repeat(100_000))]))
    await writer.close()
    const whole = await fs.readFile(archivePath)

    await expect(environmentOf(item, whole.subarray(0, Math.floor(whole.length / 2))).pull({ item, tables: null })).rejects.toThrow()
    await expect(fs.access(path.join(folder, 'seen'))).rejects.toThrow()
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
  })

  it('replaces the local copy and records the synchronization only once the data is restored', async () => {
    expect(await environmentOf(postgresItem, Buffer.from('new archive')).pull({ item: postgresItem, tables: null })).toEqual({ done: true, detail: 'database restored in db' })

    expect(await fs.readFile(path.join(folder, 'seen'), 'utf-8')).toBe('previous copy')
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'new archive' })
    expect((await readSyncJournal()).get(ITEM_PATH)).toMatchObject({ remoteUpdatedAt: UPDATED_AT, backend: 'team', remoteVersion: 'v2' })
  })

  it('leaves the local copy and the synchronization record as they were when the container refuses the archive', async () => {
    await fakeDocker('echo "pg_restore: error: input file does not appear to be a valid archive" >&2; exit 1')
    await expect(environmentOf(postgresItem, Buffer.from('new archive')).pull({ item: postgresItem, tables: null })).rejects.toThrow('does not appear to be a valid archive')

    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
    expect((await readSyncJournal()).get(ITEM_PATH)).toEqual(PREVIOUS_RECORD)
  })

  it.each<[string, EnvironmentItem, Buffer, string]>([
    ['a native database archive refused before the container', mariadbItem, gzipSync('-- dump\nUSE `shop`;\n'), 'the dump names its own database'],
    ['a truncated native bucket archive', { kind: 'bucket', path: ITEM_PATH, ...open, bucket: 'uploads', format: 'native' }, gzipSync(Buffer.alloc(700)), 'is not a complete tar.gz archive'],
    ['a file that is not a Redis archive', { kind: 'redis', path: ITEM_PATH, ...open, url: 'redis://127.0.0.1:1/0' }, Buffer.from('not an archive'), '']
  ])('leaves the local copy and the synchronization record as they were for %s', async (_case, item, archive, message) => {
    await expect(environmentOf(item, archive).pull({ item, tables: null })).rejects.toThrow(message)

    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
    expect((await readSyncJournal()).get(ITEM_PATH)).toEqual(PREVIOUS_RECORD)
  })

  it('reports a restore whose synchronization cannot be recorded, the local copy replaced', async () => {
    const listings = [true, false]
    const listing = async (): Promise<RemoteFile[]> => {
      if (listings.shift() ?? false) {
        return [{ path: ITEM_PATH, size: 11, updatedAt: UPDATED_AT, version: 'v2' }]
      }
      throw new Error('backend unreachable')
    }
    const result = await environmentOf(postgresItem, Buffer.from('new archive'), listing).pull({ item: postgresItem, tables: null })

    expect(result).toEqual({ done: true, detail: 'database restored in db, not recorded as synchronized: backend unreachable' })
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'new archive' })
    expect((await readSyncJournal()).get(ITEM_PATH)).toEqual(PREVIOUS_RECORD)
  })

  it.each<[string, () => Promise<RemoteFile[]>]>([
    ['failed', async () => Promise.reject(new Error('backend unreachable'))],
    ['did not hold the item', async () => []]
  ])('does not record as synchronized a pull whose listing before the download %s, whatever the listing after', async (_case, before) => {
    const listings = [before, async (): Promise<RemoteFile[]> => [{ path: ITEM_PATH, size: 11, updatedAt: UPDATED_AT, version: 'v3' }]]
    const listing = async (): Promise<RemoteFile[]> => (listings.length > 1 ? listings.shift()! : listings[0])()
    const result = await environmentOf(postgresItem, Buffer.from('new archive'), listing).pull({ item: postgresItem, tables: null })

    expect(result).toEqual({ done: true, detail: 'database restored in db, not recorded as synchronized: the copy of team could not be listed before the pull: pull again' })
    expect((await readSyncJournal()).get(ITEM_PATH)).toEqual(PREVIOUS_RECORD)
  })

  it('pulls without recording from a backend that lists nothing', async () => {
    const result = await environmentOf(postgresItem, Buffer.from('new archive'), async () => null).pull({ item: postgresItem, tables: null })

    expect(result).toEqual({ done: true, detail: 'database restored in db' })
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'new archive' })
    expect((await readSyncJournal()).get(ITEM_PATH)).toEqual(PREVIOUS_RECORD)
  })

  it('does not record as synchronized a copy of the backend that changed during the pull', async () => {
    const versions = ['v2', 'v3']
    const listing = async (): Promise<RemoteFile[]> => [{ path: ITEM_PATH, size: 11, updatedAt: UPDATED_AT, version: versions.shift() ?? 'v3' }]
    const result = await environmentOf(postgresItem, Buffer.from('new archive'), listing).pull({ item: postgresItem, tables: null })

    expect(result).toEqual({ done: true, detail: 'database restored in db, not recorded as synchronized: the copy of team changed during the pull: pull again' })
    expect((await readSyncJournal()).get(ITEM_PATH)).toEqual(PREVIOUS_RECORD)
  })

  it('reports what the restore could not clean up once the database was restored', async () => {
    await fakeDocker('echo "its former copy adt_replaced_0123 could not be dropped: drop it by hand"')
    const result = await environmentOf(postgresItem, Buffer.from('new archive')).pull({ item: postgresItem, tables: null })

    expect(result).toEqual({ done: true, detail: 'database restored in db, but its former copy adt_replaced_0123 could not be dropped: drop it by hand' })
    expect((await readSyncJournal()).get(ITEM_PATH)).toMatchObject({ remoteVersion: 'v2' })
  })

  it('refuses a pull and a push while another process transfers the item, changing nothing', async () => {
    const environment = environmentOf(postgresItem, Buffer.from('new archive'))
    const key = createHash('sha256').update(ITEM_PATH).digest('hex')
    await fs.mkdir(path.join(folder, 'env', '.devtool-locks'))
    await fs.writeFile(path.join(folder, 'env', '.devtool-locks', `${key}.lock`), String(process.ppid))

    await expect(environment.pull({ item: postgresItem, tables: null })).rejects.toThrow(`api/db.dump is in use by another process (${process.ppid})`)
    await expect(environment.push({ item: postgresItem, tables: null })).rejects.toThrow('api/db.dump is in use by another process')
    expect(downloads).toBe(0)
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
  })

  it('refuses a transfer of an item another environment of the same folder runs, whatever their cache folders and spellings of its path', async () => {
    let open = (): void => undefined
    downloadGate = new Promise(resolve => {
      open = resolve
    })
    const first = environmentOf(postgresItem, Buffer.from('new archive'), undefined, path.join(folder, 'cache-a')).pull({ item: postgresItem, tables: null })
    await vi.waitFor(() => {
      expect(downloads).toBe(1)
    })

    const second = environmentOf(postgresItem, Buffer.from('new archive'), undefined, path.join(folder, 'cache-b'))
    await expect(second.pull({ item: postgresItem, tables: null })).rejects.toThrow('api/db.dump is being transferred')
    const spelled: EnvironmentItem = { ...postgresItem, path: 'API/db.dump' }
    await expect(environmentOf(spelled, Buffer.from('new archive')).pull({ item: spelled, tables: null })).rejects.toThrow('API/db.dump is being transferred')
    open()
    expect(await first).toEqual({ done: true, detail: 'database restored in db' })
  })

  it('refuses some tables of an archive restoring the whole database only, before downloading it', async () => {
    await expect(environmentOf(mariadbItem, gzipSync('-- dump\n')).pull({ item: mariadbItem, tables: ['users'] })).rejects.toThrow('api/db.dump is a native mariadb archive: pull the whole database')

    expect(downloads).toBe(0)
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
  })
})
