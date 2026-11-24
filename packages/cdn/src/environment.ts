import fs from 'node:fs/promises'
import path from 'node:path'
import type { S3Client } from '@aws-sdk/client-s3'
import { ArchiveWriter, readArchive, type RecordHeader } from './archive.js'
import { createS3Client, restoreBucket, type S3Options, snapshotBucket } from './buckets.js'
import type { CdnClient } from './client.js'
import { defaultEnvironmentFolder, localPathOf, writeLocalFile } from './directory.js'
import { databaseEngine, type DatabaseEngineName, isDatabaseEngineName } from './engines.js'
import { listRedisGroups, redisDatabaseName, redisRecordGroup, restoreRedis, snapshotRedis } from './redis.js'
import { readSyncJournal, type SyncRecord, writeSyncRecord } from './sync-journal.js'
import { type ConfigFormat, configFormatOf, countChoices, diffConfig, type KeyChoice, type KeyDifference, mergeConfig } from './config-merge.js'

/** Path of the shared devtool configuration, the file declaring the environment. */
export const SHARED_CONFIG_PATH = 'devtool/config.yml'

const MEDIA_TYPES: Record<string, string> = {
  '.yml': 'application/yaml',
  '.yaml': 'application/yaml',
  '.json': 'application/json',
  '.env': 'text/plain',
  '.gz': 'application/gzip'
}

/** A file of the environment: a configuration, a database archive, a bucket or a Redis database snapshot. */
export type EnvironmentItem
  = | { kind: 'file', path: string }
    | { kind: 'database', path: string, engine: DatabaseEngineName, container: string }
    | { kind: 'bucket', path: string, bucket: string }
    | { kind: 'redis', path: string, url: string }

/** What the environment is made of, as declared in the `environment` section of the configuration. */
export interface EnvironmentOptions {
  /** The local folder mirroring the devtool files of the CDN. */
  folder: string
  /** What is synchronized with the CDN. */
  items: EnvironmentItem[]
  /** The configuration files of the environment, synchronized or not. */
  configFiles: EnvironmentConfigFile[]
  /** The items pulled on their own, on a schedule or when the server starts. */
  autoPulls: EnvironmentAutoPull[]
  s3: S3Options | null
}

/** When an item of the environment is pulled on its own. */
export interface EnvironmentAutoPull {
  path: string
  /** Cron expression of its pulls, null for none. */
  cron: string | null
  /** Whether it is pulled when the server starts. */
  startup: boolean
}

/** A configuration file of the environment and how the configurations tab shows it. */
export interface EnvironmentConfigFile {
  path: string
  /** Whether the configurations tab lists it. */
  display: boolean
  /** Whether the configurations tab lists its personal `.local` override. */
  local: boolean
}

/** An item to transfer, whole or restricted to some tables of a database or key groups of a Redis database. */
export interface EnvironmentSelection {
  item: EnvironmentItem
  tables: string[] | null
  /** For a configuration file, the value to keep for each differing key; the whole file when missing. */
  keys?: KeyChoice[] | null
}

/** Outcome of the transfer of one item. */
export interface TransferResult {
  done: boolean
  detail: string
}

/** Size and last change of a copy of an item. */
export interface CopyInfo {
  size: number
  updatedAt: Date
}

/** An item with its local copy and its copy on the CDN. */
export interface DescribedItem {
  item: EnvironmentItem
  local: CopyInfo | null
  /** The CDN copy, null when there is none, "unknown" when the CDN cannot list its files. */
  remote: CopyInfo | null | 'unknown'
  /** Dates of both copies when they were last made equal, null when never recorded. */
  synced: SyncRecord | null
}

/**
 * Reads a record of the configuration.
 *
 * @param value - The raw value.
 * @returns The record, empty when the value is not one.
 */
function recordOf (value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/**
 * Reads a list of records of the configuration.
 *
 * @param value - The raw value.
 * @returns The records.
 */
function recordsOf (value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(recordOf) : []
}

/**
 * Reads when an item of the environment is pulled on its own, `pull: { cron, startup }`.
 *
 * @param path - The path of the item.
 * @param value - The raw `pull` setting.
 * @returns When it is pulled, null when it never is on its own.
 */
function readAutoPull (path: string, value: unknown): EnvironmentAutoPull | null {
  if (value === undefined) {
    return null
  }
  const pull = recordOf(value)
  if (pull !== value || (pull.cron !== undefined && typeof pull.cron !== 'string') || (pull.startup !== undefined && typeof pull.startup !== 'boolean')) {
    throw new Error(`invalid pull of ${path} in the environment: ${JSON.stringify(value)}`)
  }
  return pull.cron || pull.startup ? { path, cron: typeof pull.cron === 'string' ? pull.cron : null, startup: pull.startup === true } : null
}

/**
 * Reads the `environment` section of the devtool configuration, its `folder` being the parent of the
 * configuration folder when it names none, each of its `files` a path or `{ path, display, local, sync, pull }`,
 * its databases, buckets and Redis databases taking a `pull` too.
 *
 * @param section - The raw section.
 * @returns The environment, or null when the section is missing.
 */
export function readEnvironmentOptions (section: unknown): EnvironmentOptions | null {
  if (typeof section !== 'object' || section === null) {
    return null
  }

  const record = recordOf(section)
  const items: EnvironmentItem[] = []
  const configFiles: EnvironmentConfigFile[] = []
  const autoPulls: EnvironmentAutoPull[] = []
  const addItem = (item: EnvironmentItem, pull: unknown): void => {
    items.push(item)
    const autoPull = readAutoPull(item.path, pull)
    if (autoPull) {
      autoPulls.push(autoPull)
    }
  }
  for (const file of Array.isArray(record.files) ? record.files : []) {
    const entry = typeof file === 'string' ? { path: file } : recordOf(file)
    const flags = [entry.display, entry.local, entry.sync]
    if (typeof entry.path !== 'string' || flags.some(flag => flag !== undefined && typeof flag !== 'boolean')) {
      throw new Error(`invalid file in the environment: ${JSON.stringify(file)}`)
    }
    configFiles.push({ path: entry.path, display: entry.display !== false, local: entry.local !== false })
    if (entry.sync !== false) {
      addItem({ kind: 'file', path: entry.path }, entry.pull)
    }
  }
  for (const database of recordsOf(record.databases)) {
    if (typeof database.path !== 'string' || !isDatabaseEngineName(database.engine) || typeof database.container !== 'string') {
      throw new Error(`invalid database in the environment: ${JSON.stringify(database)}`)
    }
    addItem({ kind: 'database', path: database.path, engine: database.engine, container: database.container }, database.pull)
  }
  for (const bucket of recordsOf(record.buckets)) {
    if (typeof bucket.path !== 'string' || typeof bucket.bucket !== 'string') {
      throw new Error(`invalid bucket in the environment: ${JSON.stringify(bucket)}`)
    }
    addItem({ kind: 'bucket', path: bucket.path, bucket: bucket.bucket }, bucket.pull)
  }
  for (const redis of recordsOf(record.redis)) {
    if (typeof redis.path !== 'string' || typeof redis.url !== 'string') {
      throw new Error(`invalid Redis database in the environment: ${JSON.stringify({ path: redis.path })}`)
    }
    addItem({ kind: 'redis', path: redis.path, url: redis.url }, redis.pull)
  }

  const s3 = recordOf(record.s3)
  return {
    folder: typeof record.folder === 'string' ? record.folder : defaultEnvironmentFolder(),
    items,
    configFiles,
    autoPulls,
    s3:
      typeof s3.endpoint === 'string' && typeof s3.accessKeyId === 'string' && typeof s3.secretAccessKey === 'string'
        ? { endpoint: s3.endpoint, accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey, region: typeof s3.region === 'string' ? s3.region : 'us-east-1' }
        : null
  }
}

/**
 * Reads targets given as `<path>`, `<path>:<table>,<table>` or `<path>:<key group>,<key group>`.
 *
 * @param options - The environment.
 * @param targets - The targets.
 * @returns The selections, every item when no target is given.
 */
export function parseTargets (options: EnvironmentOptions, targets: string[]): EnvironmentSelection[] {
  if (targets.length === 0) {
    return options.items.map(item => ({ item, tables: null }))
  }

  return targets.map(target => {
    const separator = target.indexOf(':')
    const itemPath = separator < 0 ? target : target.slice(0, separator)
    const item = options.items.find(candidate => candidate.path === itemPath)
    if (!item) {
      throw new Error(`${itemPath} is not part of the environment (${options.items.map(candidate => candidate.path).join(', ')})`)
    }

    if (separator < 0) {
      return { item, tables: null }
    }

    if (item.kind !== 'database' && item.kind !== 'redis') {
      throw new Error(`${itemPath} has no tables or key groups`)
    }

    const tables = target.slice(separator + 1).split(',').map(table => table.trim()).filter(table => table !== '')
    return { item, tables: tables.length > 0 ? tables : null }
  })
}

/**
 * Lists the tables of the local database of an item, or the key groups of its local Redis database.
 *
 * @param item - The database or Redis item.
 * @returns The tables or key groups.
 */
export async function listTables (item: Extract<EnvironmentItem, { kind: 'database' | 'redis' }>): Promise<string[]> {
  return item.kind === 'redis' ? listRedisGroups(item.url) : databaseEngine(item.engine).listTables(item.container)
}

/**
 * Tells whether pulling a selection overwrites local data.
 *
 * @param selection - The selection.
 * @returns True for databases and buckets.
 */
export function overwritesLocalData (selection: EnvironmentSelection): boolean {
  return selection.item.kind !== 'file'
}

/**
 * Gives the media type of a file of the environment.
 *
 * @param filePath - The path of the file.
 * @returns The media type.
 */
function mediaTypeOf (filePath: string): string {
  const extension = path.extname(filePath)
  return MEDIA_TYPES[extension] ?? 'application/octet-stream'
}

/**
 * Checks that every requested table or key group exists.
 *
 * @param tables - The requested tables or key groups.
 * @param known - The tables or key groups found.
 * @param where - Where they were looked for.
 * @param parts - What is checked, for the error message.
 */
function assertKnownTables (tables: string[], known: Iterable<string>, where: string, parts = 'tables'): void {
  const knownTables = new Set(known)
  const unknown = tables.filter(table => !knownTables.has(table))
  if (unknown.length > 0) {
    throw new Error(`unknown ${parts} in ${where}: ${unknown.join(', ')}`)
  }
}

/**
 * The local environment of the developer, kept in sync with the devtool files of the CDN.
 */
export class Environment {
  private _s3: S3Client | null = null

  /**
   * @param _client - The client of the devtool files of the CDN.
   * @param _options - The environment.
   */
  constructor (
    private readonly _client: CdnClient,
    private readonly _options: EnvironmentOptions
  ) {}

  /**
   * Describes every item with its local copy and its copy on the CDN. The local copies are described
   * even when the CDN cannot be reached.
   *
   * @returns The items, in their declaration order, and why the CDN copies are unknown, if they are.
   */
  async describe (): Promise<{ items: DescribedItem[], remoteError: string | null }> {
    let remoteFiles: Awaited<ReturnType<CdnClient['list']>> = null
    let remoteError: string | null = null
    try {
      remoteFiles = await this._client.list()
    } catch (error) {
      remoteError = error instanceof Error ? error.message : String(error)
    }

    const remoteByPath = new Map(remoteFiles?.map(file => [file.path, { size: file.size, updatedAt: file.updatedAt }]))
    const journal = await readSyncJournal()
    const items = await Promise.all(
      this._options.items.map(async item => {
        const stat = await fs.stat(localPathOf(this._options.folder, item.path)).catch(() => null)
        return {
          item,
          local: stat?.isFile() ? { size: stat.size, updatedAt: stat.mtime } : null,
          remote: remoteFiles === null ? ('unknown' as const) : (remoteByPath.get(item.path) ?? null),
          synced: journal.get(item.path) ?? null
        }
      })
    )

    return { items, remoteError }
  }

  /**
   * Replaces the local copy of an item, and the local data it holds, by the one of the CDN.
   *
   * @param selection - The item, the tables or key groups to restore, or the keys to take for a configuration file.
   * @returns What was done.
   */
  async pull (selection: EnvironmentSelection): Promise<TransferResult> {
    const { item, tables } = selection
    if (item.kind === 'file' && selection.keys) {
      return this.pullKeys(item.path, selection.keys)
    }

    if (!(await this.download(item.path))) {
      return { done: false, detail: 'absent from the CDN' }
    }

    const localPath = localPathOf(this._options.folder, item.path)
    await this.recordSync(item.path)
    if (item.kind === 'file') {
      return { done: true, detail: localPath }
    }

    if (item.kind === 'bucket') {
      const count = await restoreBucket(this.s3(), item.bucket, readArchive(localPath))
      return { done: true, detail: `${count} objects restored in ${item.bucket}` }
    }

    if (item.kind === 'redis') {
      const records = readArchive(localPath)
      const first = await records.next()
      if (first.done || first.value.header.type !== 'redis') {
        throw new Error(`${item.path} is not a Redis archive`)
      }

      const restored = await restoreRedis(item.url, records, tables)
      if (tables !== null) {
        assertKnownTables(tables, restored.groups, item.path, 'key groups')
      }
      return {
        done: true,
        detail: tables === null ? `${restored.count} keys restored in Redis ${redisDatabaseName(item.url)}` : `key groups restored: ${tables.join(', ')} (${restored.count} keys)`
      }
    }

    const engine = databaseEngine(item.engine)
    const records = readArchive(localPath)
    const first = await records.next()
    if (first.done || first.value.header.type !== 'database' || first.value.header.engine !== item.engine) {
      throw new Error(`${item.path} is not a ${item.engine} archive`)
    }

    if (tables === null) {
      await engine.reset(item.container)
    } else {
      assertKnownTables(tables, await engine.listTables(item.container), item.container)
    }

    const restored: string[] = []
    for await (const { header, body } of records) {
      if (header.type === 'schema' && tables === null) {
        await engine.importSchema(item.container, body)
      } else if (header.type === 'table' && typeof header.name === 'string' && (tables === null || tables.includes(header.name))) {
        await engine.importTable(item.container, header.name, body, tables !== null)
        restored.push(header.name)
      }
    }
    if (tables !== null) {
      assertKnownTables(tables, restored, item.path)
    }
    await engine.finish(item.container)

    return { done: true, detail: tables === null ? `database restored (${restored.length} tables)` : `tables restored: ${restored.join(', ')}` }
  }

  /**
   * Sends the local copy of an item to the CDN, after dumping the local data it holds. For some tables of a database, only their rows are replaced in the stored archive.
   *
   * @param selection - The item, the tables or key groups to dump, or the keys to send for a configuration file.
   * @returns What was done.
   */
  async push (selection: EnvironmentSelection): Promise<TransferResult> {
    const { item, tables } = selection
    if (item.kind === 'file' && selection.keys) {
      return this.pushKeys(item.path, selection.keys)
    }

    const localPath = localPathOf(this._options.folder, item.path)
    let detail = localPath
    if (item.kind === 'database') {
      detail = await this.writeLocal(localPath, archive => this.dumpDatabase(item, tables, archive))
    } else if (item.kind === 'bucket') {
      detail = await this.writeLocal(localPath, async archive => `${await snapshotBucket(this.s3(), item.bucket, archive)} objects of ${item.bucket}`)
    } else if (item.kind === 'redis') {
      detail = await this.writeLocal(localPath, archive => this.dumpRedis(item, tables, archive))
    } else if (!(await fs.stat(localPath).then(stat => stat.isFile(), () => false))) {
      return { done: false, detail: `no local file ${localPath}` }
    }

    await this._client.upload(item.path, localPath, mediaTypeOf(item.path))
    await this.recordSync(item.path)
    return { done: true, detail }
  }

  /**
   * Lists the keys whose values differ between the local and CDN copies of a configuration file.
   *
   * @param item - The file item.
   * @returns The differing keys.
   */
  async diffKeys (item: EnvironmentItem): Promise<KeyDifference[]> {
    const { format, local, remote } = await this.readBothCopies(item.path)
    return diffConfig(format, local, remote)
  }

  /**
   * Writes in the local copy of a configuration file the CDN values chosen for its differing keys.
   *
   * @param filePath - The path of the file.
   * @param keys - The value to keep for each differing key.
   * @returns What was done.
   */
  private async pullKeys (filePath: string, keys: KeyChoice[]): Promise<TransferResult> {
    const { format, local, remote } = await this.readBothCopies(filePath)
    const differences = diffConfig(format, local, remote)
    const merged = mergeConfig(format, local, 'local', differences, keys)
    await writeLocalFile(localPathOf(this._options.folder, filePath), merged)
    if (diffConfig(format, merged, remote).length === 0) {
      await this.recordSync(filePath)
    }

    const counts = countChoices(differences, keys, 'local')
    return { done: true, detail: `keys merged: ${counts.remote} from the CDN, ${counts.local} kept local` }
  }

  /**
   * Sends to the CDN its copy of a configuration file with the local values chosen for its
   * differing keys, leaving the local copy as it is.
   *
   * @param filePath - The path of the file.
   * @param keys - The value to keep for each differing key.
   * @returns What was done.
   */
  private async pushKeys (filePath: string, keys: KeyChoice[]): Promise<TransferResult> {
    const { format, local, remote } = await this.readBothCopies(filePath)
    const differences = diffConfig(format, local, remote)
    const merged = mergeConfig(format, remote, 'remote', differences, keys)
    const mergedPath = `${localPathOf(this._options.folder, filePath)}.merged`
    try {
      await fs.writeFile(mergedPath, merged, { mode: 0o600 })
      await this._client.upload(filePath, mergedPath, mediaTypeOf(filePath))
    } finally {
      await fs.rm(mergedPath, { force: true })
    }
    if (diffConfig(format, local, merged).length === 0) {
      await this.recordSync(filePath)
    }

    const counts = countChoices(differences, keys, 'remote')
    return { done: true, detail: `keys merged: ${counts.local} from local, ${counts.remote} kept on the CDN` }
  }

  /**
   * Reads the local and CDN copies of a configuration file, without replacing the local one.
   *
   * @param filePath - The path of the file.
   * @returns Its format and both texts.
   */
  private async readBothCopies (filePath: string): Promise<{ format: ConfigFormat, local: string, remote: string }> {
    const format = configFormatOf(filePath)
    if (!format) {
      throw new Error(`${filePath} cannot be merged key by key: YAML, JSON and .env files only`)
    }

    const remotePath = `${localPathOf(this._options.folder, filePath)}.remote`
    try {
      if (!(await this.download(filePath, remotePath))) {
        throw new Error(`${filePath} is not on the CDN`)
      }

      const local = await fs.readFile(localPathOf(this._options.folder, filePath), 'utf-8').catch(() => {
        throw new Error(`no local file ${localPathOf(this._options.folder, filePath)}`)
      })
      return { format, local, remote: await fs.readFile(remotePath, 'utf-8') }
    } finally {
      await fs.rm(remotePath, { force: true })
    }
  }

  /**
   * Records in the synchronization journal the dates of both copies of an item, now equal, so a
   * later change on either side shows; neither copy is touched.
   *
   * @param filePath - The path of the item.
   */
  private async recordSync (filePath: string): Promise<void> {
    const remote = (await this._client.list())?.find(file => file.path === filePath)
    const local = await fs.stat(localPathOf(this._options.folder, filePath)).catch(() => null)
    if (remote && local) {
      await writeSyncRecord(filePath, { localUpdatedAt: local.mtime, remoteUpdatedAt: remote.updatedAt })
    }
  }

  /**
   * Writes an archive of a local database: its schema and the rows of every table, or the stored
   * archive with the rows of some tables replaced.
   *
   * @param item - The database item.
   * @param tables - The tables to dump, or null for the whole database.
   * @param archive - The archive being written.
   * @returns What was dumped.
   */
  private async dumpDatabase (item: Extract<EnvironmentItem, { kind: 'database' }>, tables: string[] | null, archive: ArchiveWriter): Promise<string> {
    const engine = databaseEngine(item.engine)
    const localTables = await engine.listTables(item.container)
    if (tables === null) {
      await archive.add({ type: 'database', engine: item.engine })
      await archive.add({ type: 'schema' }, engine.dumpSchema(item.container))
      for (const table of localTables) {
        await archive.add({ type: 'table', name: table }, engine.dumpTable(item.container, table))
      }
      return `database dumped (${localTables.length} tables)`
    }

    assertKnownTables(tables, localTables, item.container)
    await this.copyBase(item.path, archive, header => header.type !== 'table' || typeof header.name !== 'string' || !tables.includes(header.name))
    for (const table of tables) {
      await archive.add({ type: 'table', name: table }, engine.dumpTable(item.container, table))
    }

    return `tables dumped: ${tables.join(', ')}`
  }

  /**
   * Writes an archive of a local Redis database: every key, or the stored archive with the keys of
   * some groups replaced.
   *
   * @param item - The Redis item.
   * @param groups - The key groups to dump, or null for the whole database.
   * @param archive - The archive being written.
   * @returns What was dumped.
   */
  private async dumpRedis (item: Extract<EnvironmentItem, { kind: 'redis' }>, groups: string[] | null, archive: ArchiveWriter): Promise<string> {
    if (groups === null) {
      await archive.add({ type: 'redis' })
      return `${await snapshotRedis(item.url, archive, null)} keys of Redis ${redisDatabaseName(item.url)}`
    }

    assertKnownTables(groups, await listRedisGroups(item.url), redisDatabaseName(item.url), 'key groups')
    await this.copyBase(item.path, archive, header => {
      const group = redisRecordGroup(header)
      return group === null || !groups.includes(group)
    })
    const count = await snapshotRedis(item.url, archive, groups)

    return `key groups dumped: ${groups.join(', ')} (${count} keys)`
  }

  /**
   * Copies to an archive the records of the CDN copy of an item that are kept.
   *
   * @param itemPath - The path of the item.
   * @param archive - The archive being written.
   * @param keep - Tells whether a record of the CDN copy is kept.
   */
  private async copyBase (itemPath: string, archive: ArchiveWriter, keep: (header: RecordHeader) => boolean): Promise<void> {
    const basePath = `${localPathOf(this._options.folder, itemPath)}.base`
    try {
      if (!(await this.download(itemPath, basePath))) {
        throw new Error(`${itemPath} is not on the CDN yet: push the whole item first`)
      }

      for await (const { header, body } of readArchive(basePath)) {
        if (keep(header)) {
          await archive.add(header, body)
        }
      }
    } finally {
      await fs.rm(basePath, { force: true })
    }
  }

  /**
   * Writes an archive to a local file, replaced only once the archive is complete.
   *
   * @param localPath - The local file.
   * @param fill - Writes the records of the archive.
   * @returns What `fill` reports.
   */
  private async writeLocal (localPath: string, fill: (archive: ArchiveWriter) => Promise<string>): Promise<string> {
    await fs.mkdir(path.dirname(localPath), { recursive: true, mode: 0o700 })
    const partialPath = `${localPath}.part`
    const archive = new ArchiveWriter(partialPath)
    try {
      const detail = await fill(archive)
      await archive.close()
      await fs.rename(partialPath, localPath)
      return detail
    } catch (error) {
      archive.abort()
      throw error
    } finally {
      await fs.rm(partialPath, { force: true })
    }
  }

  /**
   * Downloads a file of the CDN to a local file, replaced only once the download is complete.
   *
   * @param filePath - The path of the file on the CDN.
   * @param localPath - The local file, its mirror in the environment directory by default.
   * @returns False when the CDN has no such file.
   */
  private async download (filePath: string, localPath = localPathOf(this._options.folder, filePath)): Promise<boolean> {
    const content = await this._client.download(filePath)
    if (!content) {
      return false
    }

    await writeLocalFile(localPath, content)
    return true
  }

  /**
   * Gives the client of the local S3 server.
   *
   * @returns The client.
   */
  private s3 (): S3Client {
    if (!this._options.s3) {
      throw new Error('the environment declares buckets without `s3` server')
    }

    this._s3 ??= createS3Client(this._options.s3)
    return this._s3
  }
}
