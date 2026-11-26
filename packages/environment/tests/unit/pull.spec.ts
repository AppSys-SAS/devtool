import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendContext, EnvironmentBackend } from '../../src/backends/backend.js'
import { Environment, type EnvironmentItem } from '../../src/environment.js'
import { readSyncJournal } from '../../src/sync-journal.js'

const UPDATED_AT = new Date('2026-01-01T00:00:00Z')
const ITEM_PATH = 'api/db.dump'
const open = { backend: 'team', encryption: null, groups: { pull: null, push: null } }
const postgresItem: EnvironmentItem = { kind: 'database', path: ITEM_PATH, ...open, engine: 'postgres', container: 'db', database: null, format: 'native' }
const mariadbItem: EnvironmentItem = { ...postgresItem, engine: 'mariadb' }

let folder: string
let downloads: number

/**
 * Builds an environment of one item whose backend stores one archive.
 * @param item - The item.
 * @param archive - The archive the backend stores.
 * @param listing - Lists the files of the backend.
 * @returns The environment.
 */
function environmentOf (item: EnvironmentItem, archive: Buffer, listing?: () => Promise<never>): Environment {
  const backend: EnvironmentBackend = {
    list: listing ?? (async () => [{ path: item.path, size: archive.length, updatedAt: UPDATED_AT, version: 'v2' }]),
    download: async () => {
      downloads += 1
      return Readable.from([archive])
    },
    upload: async () => undefined,
    remove: async () => undefined,
    close: async () => undefined
  }
  const context: BackendContext = { resolve: async text => text, askSecret: async () => '', cacheDir: folder, configFolder: folder, auth: null }
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
  await fs.mkdir(path.join(folder, 'env', 'api'), { recursive: true })
  await fs.mkdir(path.join(folder, 'bin'))
  await fs.writeFile(path.join(folder, 'env', 'api', 'db.dump'), 'previous copy')
  await fakeDocker(`cat "${path.join(folder, 'env', 'api', 'db.dump')}" > "${path.join(folder, 'seen')}"`)
  vi.stubEnv('PATH', `${path.join(folder, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`)
  vi.stubEnv('ADT_CONFIG_FOLDER', folder)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fs.rm(folder, { recursive: true, force: true })
})

describe('pull of an item holding local data', () => {
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
    expect(await readSyncJournal()).toEqual(new Map())
  })

  it.each<[string, EnvironmentItem, Buffer, string]>([
    ['a native database archive refused before the container', mariadbItem, gzipSync('-- dump\nUSE `shop`;\n'), 'the dump names its own database'],
    ['a truncated native bucket archive', { kind: 'bucket', path: ITEM_PATH, ...open, bucket: 'uploads', format: 'native' }, gzipSync(Buffer.alloc(700)), 'is not a complete tar.gz archive'],
    ['a file that is not a Redis archive', { kind: 'redis', path: ITEM_PATH, ...open, url: 'redis://127.0.0.1:1/0' }, Buffer.from('not an archive'), '']
  ])('leaves the local copy and the synchronization record as they were for %s', async (_case, item, archive, message) => {
    await expect(environmentOf(item, archive).pull({ item, tables: null })).rejects.toThrow(message)

    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
    expect(await readSyncJournal()).toEqual(new Map())
  })

  it('reports a restore whose synchronization cannot be recorded, the local copy replaced', async () => {
    const failingList = async (): Promise<never> => Promise.reject(new Error('backend unreachable'))
    const result = await environmentOf(postgresItem, Buffer.from('new archive'), failingList).pull({ item: postgresItem, tables: null })

    expect(result).toEqual({ done: true, detail: 'database restored in db, not recorded as synchronized: backend unreachable' })
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'new archive' })
  })

  it('refuses some tables of an archive restoring the whole database only, before downloading it', async () => {
    await expect(environmentOf(mariadbItem, gzipSync('-- dump\n')).pull({ item: mariadbItem, tables: ['users'] })).rejects.toThrow('api/db.dump is a native mariadb archive: pull the whole database')

    expect(downloads).toBe(0)
    expect(await localState()).toEqual({ files: ['db.dump'], copy: 'previous copy' })
  })
})
