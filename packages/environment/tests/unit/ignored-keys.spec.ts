import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendContext, EnvironmentBackend, RemoteFile } from '../../src/backends/backend.js'
import { IgnoredKeys } from '../../src/config-merge.js'
import { Environment, type EnvironmentItem } from '../../src/environment.js'

const ITEM: EnvironmentItem = { kind: 'file', path: 'db/connections.json', backend: 'memory', encryption: null, groups: { pull: null, push: null }, ignore: new IgnoredKeys(['connections.*.lastUsedAt']) }

let folder: string
let files: Map<string, { content: Buffer, version: number }>
let environment: Environment

/**
 * Writes a connections file as JSON text.
 * @param url - The URL of its connection.
 * @param lastUsedAt - When its connection was last used.
 * @returns The text.
 */
function connections (url: string, lastUsedAt: number): string {
  return `${JSON.stringify({ version: 1, connections: [{ id: 'dev', url, lastUsedAt }] }, null, 2)}\n`
}

/**
 * Builds a backend keeping its files in memory, each write giving a new version.
 * @returns The backend.
 */
function memoryBackend (): EnvironmentBackend {
  return {
    list: async (): Promise<RemoteFile[]> => [...files].map(([filePath, file]) => ({ path: filePath, size: file.content.length, updatedAt: new Date(file.version * 1000), version: String(file.version) })),
    download: async (filePath: string) => (files.has(filePath) ? Readable.from([files.get(filePath)!.content]) : null),
    upload: async (filePath: string, localFile: string) => {
      files.set(filePath, { content: await fs.readFile(localFile), version: (files.get(filePath)?.version ?? 0) + 1 })
    },
    remove: async (filePath: string) => {
      files.delete(filePath)
    },
    close: async () => undefined
  }
}

/**
 * Reads the local copy of the item.
 * @returns Its value.
 */
async function localValue (): Promise<unknown> {
  return JSON.parse(await fs.readFile(path.join(folder, 'env', ITEM.path), 'utf-8'))
}

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-ignored-keys-'))
  vi.stubEnv('ADT_CONFIG_FOLDER', path.join(folder, 'config'))
  files = new Map([[ITEM.path, { content: Buffer.from(connections('pg://shared', 1)), version: 1 }]])
  await fs.mkdir(path.join(folder, 'env', 'db'), { recursive: true })
  await fs.writeFile(path.join(folder, 'env', ITEM.path), connections('pg://shared', 99))
  const context: BackendContext = { resolve: async text => text, askSecret: async () => '', cacheDir: folder, configFolder: folder, auth: null }
  environment = new Environment(
    new Map([['memory', memoryBackend()]]),
    { folder: path.join(folder, 'env'), backends: [], defaultBackend: 'memory', items: [ITEM], configFiles: [], autoPulls: [], sections: { by: 'folder', names: new Map() }, s3: null },
    context
  )
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fs.rm(folder, { recursive: true, force: true })
})

describe('a configuration file with ignored keys', () => {
  it('is described as synchronized when only its ignored keys differ', async () => {
    const { items: [described] } = await environment.describe()
    const stat = await fs.stat(path.join(folder, 'env', ITEM.path))

    expect(described.synced).toMatchObject({ localUpdatedAt: stat.mtime, remoteVersion: '1', backend: 'memory' })
  })

  it('stays out of sync when another key differs', async () => {
    await fs.writeFile(path.join(folder, 'env', ITEM.path), connections('pg://mine', 99))

    expect((await environment.describe()).items[0].synced).toBeNull()
  })

  it('keeps its local ignored values when pulled whole', async () => {
    files.set(ITEM.path, { content: Buffer.from(connections('pg://new', 1)), version: 2 })

    expect(await environment.pull({ item: ITEM, tables: null })).toEqual({ done: true, detail: 'keys merged: 1 from memory, 0 kept local' })
    expect(await localValue()).toEqual({ version: 1, connections: [{ id: 'dev', url: 'pg://new', lastUsedAt: 99 }] })
  })

  it('keeps its local ignored values when pulled after a first listing of its backend failed', async () => {
    files.set(ITEM.path, { content: Buffer.from(connections('pg://new', 1)), version: 2 })
    const backend = memoryBackend()
    const list = backend.list
    backend.list = vi.fn(list).mockRejectedValueOnce(new Error('listing failed'))
    const context: BackendContext = { resolve: async text => text, askSecret: async () => '', cacheDir: folder, configFolder: folder, auth: null }
    const flaky = new Environment(
      new Map([['memory', backend]]),
      { folder: path.join(folder, 'env'), backends: [], defaultBackend: 'memory', items: [ITEM], configFiles: [], autoPulls: [], sections: { by: 'folder', names: new Map() }, s3: null },
      context
    )

    expect(await flaky.pull({ item: ITEM, tables: null })).toEqual({
      done: true,
      detail: 'keys merged: 1 from memory, 0 kept local, not recorded as synchronized: the copy of memory could not be listed before the pull: pull again'
    })
    expect(await localValue()).toEqual({ version: 1, connections: [{ id: 'dev', url: 'pg://new', lastUsedAt: 99 }] })
  })

  it('keeps the ignored values of its backend when pushed whole', async () => {
    await fs.writeFile(path.join(folder, 'env', ITEM.path), connections('pg://mine', 99))

    expect(await environment.push({ item: ITEM, tables: null })).toEqual({ done: true, detail: 'keys merged: 1 from local, 0 kept on memory' })
    expect(JSON.parse(files.get(ITEM.path)!.content.toString())).toEqual({ version: 1, connections: [{ id: 'dev', url: 'pg://mine', lastUsedAt: 1 }] })
  })

  it('is transferred as it is when one copy is missing', async () => {
    files.clear()

    expect(await environment.push({ item: ITEM, tables: null })).toMatchObject({ done: true })
    expect(JSON.parse(files.get(ITEM.path)!.content.toString())).toMatchObject({ connections: [{ lastUsedAt: 99 }] })
  })
})
