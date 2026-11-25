import fs from 'node:fs/promises'
import path from 'node:path'
import type { S3Client } from '@aws-sdk/client-s3'
import { ArchiveWriter, readArchive, type RecordHeader } from './archive.js'
import { type BackendContext, type BackendOptions, encrypted, EncryptionSecret, type EncryptionSettings, type EnvironmentBackend, readBackends, readEncryption } from './backends/index.js'
import { plainLengthOf } from './backends/encryption.js'
import { createS3Client, restoreBucket, type S3Options, snapshotBucket } from './buckets.js'
import { defaultEnvironmentFolder, localPathOf, writeLocalFile } from './directory.js'
import { databaseEngine, type DatabaseEngineName, isDatabaseEngineName } from './engines.js'
import { listRedisGroups, redisDatabaseName, redisRecordGroup, restoreRedis, snapshotRedis } from './redis.js'
import { readSyncJournal, type SyncRecord, writeSyncRecord } from './sync-journal.js'
import { type ConfigFormat, configFormatOf, countChoices, diffConfig, IgnoredKeys, type KeyChoice, type KeyDifference, mergeConfig } from './config-merge.js'

/** Path of the shared devtool configuration, the file declaring the environment. */
export const SHARED_CONFIG_PATH = 'devtool/config.yml'

const MEDIA_TYPES: Record<string, string> = {
  '.yml': 'application/yaml',
  '.yaml': 'application/yaml',
  '.json': 'application/json',
  '.env': 'text/plain',
  '.gz': 'application/gzip'
}

/** What every item of the environment has. */
interface ItemBase {
  path: string
  /** The name of the backend storing it, null when the environment declares no backend. */
  backend: string | null
  /** The secret encrypting the file before it reaches its backend, null to send it as it is. */
  encryption: EncryptionSettings | null
}

/** A file of the environment: a configuration, a database archive, a bucket or a Redis database snapshot. */
export type EnvironmentItem
  = | ItemBase & { kind: 'file', ignore: IgnoredKeys | null }
    | ItemBase & { kind: 'database', engine: DatabaseEngineName, container: string }
    | ItemBase & { kind: 'bucket', bucket: string }
    | ItemBase & { kind: 'redis', url: string }

/** What the environment is made of, as declared in the `environment` section of the configuration. */
export interface EnvironmentOptions {
  /** The local folder mirroring the files of the backends. */
  folder: string
  /** Where the files are stored, in their declaration order. */
  backends: BackendOptions[]
  /** The backend of the items naming none, and of the shared configuration; null when none is declared. */
  defaultBackend: string | null
  /** What is synchronized with the backends. */
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
  /** For the copy of a backend, what changes whenever it is written. */
  version?: string
}

/** An item with its local copy and its copy on its backend. */
export interface DescribedItem {
  item: EnvironmentItem
  local: CopyInfo | null
  /** The copy of the backend, null when there is none, "unknown" when the backend cannot list its files. */
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
 * Reads when an item of the environment is pulled on its own, `pull: { cron, startup }`, an empty
 * or blank cron standing for none.
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
  const cron = typeof pull.cron === 'string' && pull.cron.trim() !== '' ? pull.cron : null
  const startup = pull.startup === true
  return cron !== null || startup ? { path, cron, startup } : null
}

/**
 * Reads the keys a configuration file leaves out of its synchronization, `ignore: [<key pattern>]`.
 *
 * @param itemPath - The path of the file.
 * @param value - The raw `ignore` setting.
 * @returns The ignored keys, null when the file ignores none.
 */
function readIgnoredKeys (itemPath: string, value: unknown): IgnoredKeys | null {
  if (value === undefined) {
    return null
  }
  if (!Array.isArray(value) || !value.every(pattern => typeof pattern === 'string' && pattern !== '')) {
    throw new Error(`invalid ignore of ${itemPath} in the environment: must be a list of key paths, such as connections.*.lastUsedAt`)
  }
  if (!configFormatOf(itemPath)) {
    throw new Error(`invalid ignore of ${itemPath} in the environment: needs a YAML, JSON, TOML, XML or .env file`)
  }
  return value.length > 0 ? new IgnoredKeys(value) : null
}

/**
 * Gives the keys an item leaves out of its synchronization.
 *
 * @param item - The item.
 * @returns Its ignored keys, undefined when it ignores none.
 */
function ignoredKeysOf (item: EnvironmentItem): IgnoredKeys | undefined {
  return item.kind === 'file' ? item.ignore ?? undefined : undefined
}

/**
 * Reads the `environment` section of the devtool configuration: its `backends`, its `folder` being the
 * parent of the configuration folder when it names none, each of its `files` a path or
 * `{ path, display, local, sync, pull, backend, ignore }`, its databases, buckets and Redis databases taking a
 * `pull` and a `backend` too, an item naming no backend using the default one.
 *
 * @param section - The raw section.
 * @returns The environment, or null when the section is missing.
 */
export function readEnvironmentOptions (section: unknown): EnvironmentOptions | null {
  if (typeof section !== 'object' || section === null) {
    return null
  }

  const record = recordOf(section)
  const { backends, defaultBackend, problems } = readBackends(record.backends)
  const fatal = problems.find(problem => problem.setting !== 'environment.backends' || !problem.message.startsWith('several'))
  if (fatal) {
    throw new Error(`invalid backend in the environment: ${fatal.setting} ${fatal.message}`)
  }
  const items: EnvironmentItem[] = []
  const configFiles: EnvironmentConfigFile[] = []
  const autoPulls: EnvironmentAutoPull[] = []
  const rules = recordsOf(record.encryption).map((rule, index) => {
    const paths = Array.isArray(rule.paths) && rule.paths.every(pattern => typeof pattern === 'string') ? rule.paths : null
    const { encryption, problems: encryptionProblems } = readEncryption({ key: rule.key, password: rule.password, prompt: rule.prompt }, `environment.encryption[${index}]`)
    if (paths === null || paths.length === 0 || encryption === null) {
      throw new Error(`invalid encryption rule in the environment: environment.encryption[${index}] needs paths and ${encryptionProblems[0]?.message ?? 'a secret'}`)
    }
    return { paths, encryption }
  })
  const encryptionOf = (itemPath: string, value: unknown): EncryptionSettings | null => {
    const { encryption, problems: encryptionProblems } = readEncryption(value, `${itemPath}.encryption`)
    if (encryptionProblems.length > 0) {
      throw new Error(`invalid encryption of ${itemPath} in the environment: ${encryptionProblems[0].message}`)
    }
    return encryption ?? rules.find(rule => rule.paths.some(pattern => path.matchesGlob(itemPath, pattern)))?.encryption ?? null
  }
  const backendOf = (itemPath: string, value: unknown): string | null => {
    if (value === undefined) {
      return defaultBackend
    }
    if (typeof value !== 'string' || !backends.some(backend => backend.slug === value)) {
      throw new Error(`${itemPath}: backend ${JSON.stringify(value)} is not declared in environment.backends`)
    }
    return value
  }
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
      addItem({ kind: 'file', path: entry.path, backend: backendOf(entry.path, entry.backend), encryption: encryptionOf(entry.path, entry.encryption), ignore: readIgnoredKeys(entry.path, entry.ignore) }, entry.pull)
    }
  }
  for (const database of recordsOf(record.databases)) {
    if (typeof database.path !== 'string' || !isDatabaseEngineName(database.engine) || typeof database.container !== 'string') {
      throw new Error(`invalid database in the environment: ${JSON.stringify(database)}`)
    }
    addItem({ kind: 'database', path: database.path, backend: backendOf(database.path, database.backend), encryption: encryptionOf(database.path, database.encryption), engine: database.engine, container: database.container }, database.pull)
  }
  for (const bucket of recordsOf(record.buckets)) {
    if (typeof bucket.path !== 'string' || typeof bucket.bucket !== 'string') {
      throw new Error(`invalid bucket in the environment: ${JSON.stringify(bucket)}`)
    }
    addItem({ kind: 'bucket', path: bucket.path, backend: backendOf(bucket.path, bucket.backend), encryption: encryptionOf(bucket.path, bucket.encryption), bucket: bucket.bucket }, bucket.pull)
  }
  for (const redis of recordsOf(record.redis)) {
    if (typeof redis.path !== 'string' || typeof redis.url !== 'string') {
      throw new Error(`invalid Redis database in the environment: ${JSON.stringify({ path: redis.path })}`)
    }
    addItem({ kind: 'redis', path: redis.path, backend: backendOf(redis.path, redis.backend), encryption: encryptionOf(redis.path, redis.encryption), url: redis.url }, redis.pull)
  }

  const s3 = recordOf(record.s3)
  return {
    folder: typeof record.folder === 'string' ? record.folder : defaultEnvironmentFolder(),
    backends,
    defaultBackend,
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
 * @returns True for databases, buckets and Redis databases.
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
export function mediaTypeOf (filePath: string): string {
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
 * The local environment of the developer, kept in sync with the files of its backends.
 */
export class Environment {
  private _s3: S3Client | null = null
  private readonly _encrypted = new Map<string, EnvironmentBackend>()

  /**
   * @param _backends - The backends of the environment, by name.
   * @param _options - The environment.
   * @param _context - Reads the value blocks and asks the developer for the secrets of encrypted items.
   */
  constructor (
    private readonly _backends: ReadonlyMap<string, EnvironmentBackend>,
    private readonly _options: EnvironmentOptions,
    private readonly _context: BackendContext
  ) {}

  /**
   * Describes every item with its local copy and its copy on its backend. The local copies are
   * described even when a backend cannot be reached, which only hides the copies it stores.
   *
   * @returns The items, in their declaration order, and why the copies of a backend are unknown, by backend.
   */
  async describe (): Promise<{ items: DescribedItem[], errors: Record<string, string> }> {
    const errors: Record<string, string> = {}
    const listings = new Map<string | null, Map<string, CopyInfo> | null>()
    await Promise.all([...new Set(this._options.items.map(item => item.backend))].map(async slug => {
      try {
        const files = await this.backendOf(slug).list()
        listings.set(slug, files && new Map(files.map(file => [file.path, { size: file.size, updatedAt: file.updatedAt, version: file.version }])))
      } catch (error) {
        errors[slug ?? 'environment'] = error instanceof Error ? error.message : String(error)
        listings.set(slug, null)
      }
    }))

    const journal = await readSyncJournal()
    const items = await Promise.all(
      this._options.items.map(async item => {
        const stat = await fs.stat(localPathOf(this._options.folder, item.path)).catch(() => null)
        const listing = listings.get(item.backend)
        const synced = journal.get(item.path) ?? null
        const remote = listing?.get(item.path) ?? null
        return {
          item,
          local: stat?.isFile() ? { size: stat.size, updatedAt: stat.mtime } : null,
          remote: listing ? remote && { ...remote, size: item.encryption ? plainLengthOf(remote.size) ?? remote.size : remote.size } : ('unknown' as const),
          synced: synced?.backend === undefined || synced.backend === item.backend ? synced : null
        }
      })
    )
    for (const described of items) {
      described.synced = await this.syncedIgnoringKeys(described)
    }
    return { items, errors }
  }

  /**
   * Records as synchronized a configuration file whose copies changed since their last
   * synchronization but differ only by its ignored keys.
   *
   * @param described - The item with its copies.
   * @returns Its synchronization record, the new one when both copies are found equal.
   */
  private async syncedIgnoringKeys ({ item, local, remote, synced }: DescribedItem): Promise<SyncRecord | null> {
    if (!ignoredKeysOf(item) || !local || !remote || remote === 'unknown') {
      return synced
    }
    const remoteVersion = remote.version ?? remote.updatedAt.toISOString()
    if (synced?.localUpdatedAt.getTime() === local.updatedAt.getTime() && (synced.remoteVersion ?? synced.remoteUpdatedAt.toISOString()) === remoteVersion) {
      return synced
    }
    const differences = await this.diffKeys(item).catch(() => null)
    if (differences === null || differences.length > 0) {
      return synced
    }

    const record = { localUpdatedAt: local.updatedAt, remoteUpdatedAt: remote.updatedAt, backend: item.backend ?? undefined, remoteVersion }
    await writeSyncRecord(item.path, record)
    return record
  }

  /**
   * Replaces the local copy of an item, and the local data it holds, by the one of its backend.
   *
   * @param selection - The item, the tables or key groups to restore, or the keys to take for a configuration file.
   * @returns What was done.
   */
  async pull (selection: EnvironmentSelection): Promise<TransferResult> {
    const { item, tables } = selection
    if (item.kind === 'file' && (selection.keys || await this.mergesWhole(item))) {
      return this.pullKeys(item, selection.keys ?? null)
    }

    if (!(await this.download(item))) {
      return { done: false, detail: `absent from ${item.backend}` }
    }

    const localPath = localPathOf(this._options.folder, item.path)
    await this.recordSync(item)
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
   * Sends the local copy of an item to its backend, after dumping the local data it holds. For some tables of a database, only their rows are replaced in the stored archive.
   *
   * @param selection - The item, the tables or key groups to dump, or the keys to send for a configuration file.
   * @returns What was done.
   */
  async push (selection: EnvironmentSelection): Promise<TransferResult> {
    const { item, tables } = selection
    if (item.kind === 'file' && (selection.keys || await this.mergesWhole(item))) {
      return this.pushKeys(item, selection.keys ?? null)
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

    await this.backendFor(item).upload(item.path, localPath, mediaTypeOf(item.path))
    await this.recordSync(item)
    return { done: true, detail }
  }

  /**
   * Lists the keys whose values differ between the local copy of a configuration file and the copy of its backend.
   *
   * @param item - The file item.
   * @returns The differing keys.
   */
  async diffKeys (item: EnvironmentItem): Promise<KeyDifference[]> {
    const { format, local, remote } = await this.readBothCopies(item)
    return diffConfig(format, local, remote, ignoredKeysOf(item))
  }

  /**
   * Tells whether a whole configuration file is transferred key by key, to keep the values of its
   * ignored keys: when it ignores some and both copies exist.
   *
   * @param item - The file item.
   * @returns True when it is merged key by key.
   */
  private async mergesWhole (item: EnvironmentItem): Promise<boolean> {
    if (!ignoredKeysOf(item) || !(await fs.stat(localPathOf(this._options.folder, item.path)).then(stat => stat.isFile(), () => false))) {
      return false
    }
    return (await this.backendFor(item).list())?.some(file => file.path === item.path) ?? false
  }

  /**
   * Writes in the local copy of a configuration file the values of its backend chosen for its
   * differing keys, the local copy keeping the values of its ignored keys.
   *
   * @param item - The file item.
   * @param keys - The value to keep for each differing key, null to take every value of the backend.
   * @returns What was done.
   */
  private async pullKeys (item: EnvironmentItem, keys: KeyChoice[] | null): Promise<TransferResult> {
    const { format, local, remote } = await this.readBothCopies(item)
    const ignored = ignoredKeysOf(item)
    const differences = diffConfig(format, local, remote, ignored)
    const choices = keys ?? differences.map(difference => ({ path: difference.path, side: 'remote' as const }))
    const merged = mergeConfig(format, local, 'local', differences, choices, ignored)
    await writeLocalFile(localPathOf(this._options.folder, item.path), merged)
    if (diffConfig(format, merged, remote, ignored).length === 0) {
      await this.recordSync(item)
    }

    const counts = countChoices(differences, choices, 'local')
    return { done: true, detail: `keys merged: ${counts.remote} from ${item.backend}, ${counts.local} kept local` }
  }

  /**
   * Sends to its backend the copy of a configuration file with the local values chosen for its
   * differing keys, the copy of the backend keeping the values of its ignored keys, leaving the
   * local copy as it is.
   *
   * @param item - The file item.
   * @param keys - The value to keep for each differing key, null to send every local value.
   * @returns What was done.
   */
  private async pushKeys (item: EnvironmentItem, keys: KeyChoice[] | null): Promise<TransferResult> {
    const { format, local, remote } = await this.readBothCopies(item)
    const ignored = ignoredKeysOf(item)
    const differences = diffConfig(format, local, remote, ignored)
    const choices = keys ?? differences.map(difference => ({ path: difference.path, side: 'local' as const }))
    const merged = mergeConfig(format, remote, 'remote', differences, choices, ignored)
    const mergedPath = `${localPathOf(this._options.folder, item.path)}.merged`
    try {
      await fs.writeFile(mergedPath, merged, { mode: 0o600 })
      await this.backendFor(item).upload(item.path, mergedPath, mediaTypeOf(item.path))
    } finally {
      await fs.rm(mergedPath, { force: true })
    }
    if (diffConfig(format, local, merged, ignored).length === 0) {
      await this.recordSync(item)
    }

    const counts = countChoices(differences, choices, 'remote')
    return { done: true, detail: `keys merged: ${counts.local} from local, ${counts.remote} kept on ${item.backend}` }
  }

  /**
   * Reads the local copy of a configuration file and the copy of its backend, without replacing the local one.
   *
   * @param item - The file item.
   * @returns Its format and both texts.
   */
  private async readBothCopies (item: EnvironmentItem): Promise<{ format: ConfigFormat, local: string, remote: string }> {
    const format = configFormatOf(item.path)
    if (!format) {
      throw new Error(`${item.path} cannot be merged key by key: YAML, JSON, TOML, XML and .env files only`)
    }

    const localPath = localPathOf(this._options.folder, item.path)
    const remotePath = `${localPath}.remote`
    try {
      if (!(await this.download(item, remotePath))) {
        throw new Error(`${item.path} is not on ${item.backend}`)
      }

      const local = await fs.readFile(localPath, 'utf-8').catch(() => {
        throw new Error(`no local file ${localPath}`)
      })
      return { format, local, remote: await fs.readFile(remotePath, 'utf-8') }
    } finally {
      await fs.rm(remotePath, { force: true })
    }
  }

  /**
   * Records in the synchronization journal both copies of an item, now equal, so a later change on
   * either side shows; neither copy is touched.
   *
   * @param item - The item.
   */
  private async recordSync (item: EnvironmentItem): Promise<void> {
    const remote = (await this.backendFor(item).list())?.find(file => file.path === item.path)
    const local = await fs.stat(localPathOf(this._options.folder, item.path)).catch(() => null)
    if (remote && local) {
      await writeSyncRecord(item.path, { localUpdatedAt: local.mtime, remoteUpdatedAt: remote.updatedAt, backend: item.backend ?? undefined, remoteVersion: remote.version })
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
    await this.copyBase(item, archive, header => header.type !== 'table' || typeof header.name !== 'string' || !tables.includes(header.name))
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
    await this.copyBase(item, archive, header => {
      const group = redisRecordGroup(header)
      return group === null || !groups.includes(group)
    })
    const count = await snapshotRedis(item.url, archive, groups)

    return `key groups dumped: ${groups.join(', ')} (${count} keys)`
  }

  /**
   * Copies to an archive the records of the copy of an item on its backend that are kept.
   *
   * @param item - The item.
   * @param archive - The archive being written.
   * @param keep - Tells whether a record of the copy of the backend is kept.
   */
  private async copyBase (item: EnvironmentItem, archive: ArchiveWriter, keep: (header: RecordHeader) => boolean): Promise<void> {
    const basePath = `${localPathOf(this._options.folder, item.path)}.base`
    try {
      if (!(await this.download(item, basePath))) {
        throw new Error(`${item.path} is not on ${item.backend} yet: push the whole item first`)
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
   * Downloads the copy of an item on its backend to a local file, replaced only once the download is complete.
   *
   * @param item - The item.
   * @param localPath - The local file, its mirror in the environment directory by default.
   * @returns False when the backend has no such file.
   */
  private async download (item: EnvironmentItem, localPath = localPathOf(this._options.folder, item.path)): Promise<boolean> {
    const content = await this.backendFor(item).download(item.path)
    if (!content) {
      return false
    }

    await writeLocalFile(localPath, content)
    return true
  }

  /**
   * Gives a backend of the environment.
   *
   * @param slug - The name of the backend, null when the environment declares none.
   * @returns The backend.
   */
  private backendOf (slug: string | null): EnvironmentBackend {
    const backend = slug === null ? undefined : this._backends.get(slug)
    if (!backend) {
      throw new Error(slug === null ? 'no backend in environment.backends' : `no backend named ${slug} in environment.backends`)
    }
    return backend
  }

  /**
   * Gives the backend of an item, encrypting and decrypting its file when the item declares a secret.
   *
   * @param item - The item.
   * @returns The backend of the item.
   */
  private backendFor (item: EnvironmentItem): EnvironmentBackend {
    if (item.encryption === null) {
      return this.backendOf(item.backend)
    }
    let backend = this._encrypted.get(item.path)
    if (!backend) {
      backend = encrypted(this.backendOf(item.backend), new EncryptionSecret(item.encryption, this._context, `the file ${item.path}`))
      this._encrypted.set(item.path, backend)
    }
    return backend
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
