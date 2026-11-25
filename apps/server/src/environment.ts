import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { promisify } from 'node:util'
import { authReaderOf, readAuthOptions } from '@appsys-sas/devtool-auth'
import { readCertificate } from '@appsys-sas/devtool-certs'
import { type RawConfig, resolveCacheFolder, resolveConfigFolder } from '@appsys-sas/devtool-config'
import {
  type BackendContext,
  configFormatOf,
  type CopyInfo,
  createBackends,
  defaultEnvironmentFolder,
  Environment,
  type EnvironmentBackend,
  type EnvironmentOptions,
  type EnvironmentSelection,
  listTables,
  localPathOf,
  readEnvironmentOptions,
  redisDatabaseName,
  SHARED_CONFIG_PATH
} from '@appsys-sas/devtool-environment'
import { logger } from '@appsys-sas/devtool-shared'
import { Cron } from 'croner'
import type {
  EnvironmentCopyPayload,
  EnvironmentItemPayload,
  EnvironmentKeyChoicePayload,
  EnvironmentKeysPayload,
  EnvironmentPayload,
  EnvironmentPemPayload,
  EnvironmentRunPayload,
  EnvironmentTablesPayload
} from '@appsys-sas/devtool-shared'
import { CommandSecrets } from './command-automation.js'

const execFileAsync = promisify(execFile)

/**
 * Builds what the backends of the environment need: value blocks read from the configuration folder,
 * the cache folder, the identity provider and a way to ask the developer for a secret.
 *
 * @param config - The raw configuration.
 * @param askSecret - Asks the developer for a secret.
 * @returns The context of the backends.
 */
export function createBackendContext (config: RawConfig, askSecret: (label: string) => Promise<string>): BackendContext {
  const configFolder = resolveConfigFolder()
  const auth = readAuthOptions(config.auth).options
  const secrets = new CommandSecrets({
    account: null,
    folder: configFolder,
    runShell: async command => (await execFileAsync('/bin/sh', ['-c', command], { cwd: configFolder })).stdout,
    readAuth: authReaderOf(auth)
  })
  return { resolve: async text => secrets.resolve(text), askSecret, cacheDir: resolveCacheFolder(config), configFolder, auth }
}

/** An item asked for by the interface, whole or restricted to some tables of a database or keys of a configuration file. */
export interface EnvironmentTarget {
  path: string
  tables: string[] | null
  keys?: EnvironmentKeyChoicePayload[] | null
}

/**
 * Converts a copy description for the interface.
 *
 * @param copy - The copy.
 * @returns Its size and ISO date.
 */
function copyPayload (copy: CopyInfo): EnvironmentCopyPayload {
  return { size: copy.size, updatedAt: copy.updatedAt.toISOString() }
}

const PEM_MAX_BYTES = 1024 * 1024

/**
 * Tells what a local PEM file holds: its first certificate, with the end of its validity, or a private key.
 *
 * @param filePath - The local file.
 * @param size - Its size, larger files being left unread.
 * @returns What it holds, null when it is no PEM file or cannot be read.
 */
async function readPem (filePath: string, size: number): Promise<EnvironmentPemPayload | null> {
  if (size > PEM_MAX_BYTES) {
    return null
  }
  const content = await fs.readFile(filePath, 'utf-8').catch(() => '')
  const certificate = readCertificate(content)
  if (certificate) {
    return { kind: 'certificate', expiresAt: certificate.expiresAt }
  }
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content) ? { kind: 'privateKey' } : null
}

/**
 * Names a target the way the CLI does.
 *
 * @param target - The target.
 * @returns `<path>` or `<path>:<table>,<table>`.
 */
function targetName (target: EnvironmentTarget): string {
  if (target.keys) {
    return `${target.path} (${target.keys.length} ${target.keys.length > 1 ? 'keys' : 'key'} chosen)`
  }

  return target.tables?.length ? `${target.path}:${target.tables.join(',')}` : target.path
}

/**
 * Development environment of the developer as the interface shows it: the items with their local
 * copies and the copies of their backends, and the pulls and pushes it starts, one at a time.
 */
export class DevtoolEnvironment {
  private _backends = new Map<string, EnvironmentBackend>()
  private _context: BackendContext | null = null
  private _options: EnvironmentOptions | null = null
  private _items: EnvironmentItemPayload[] = []
  private _error: string | null = null
  private _run: EnvironmentRunPayload | null = null
  /** The scheduled pulls of the configuration. */
  private _pullJobs: Cron[] = []
  /** Why some scheduled pulls could not be scheduled. */
  private _scheduleErrors: string[] = []

  /**
   * @param _publish - Sends the state to every connected interface.
   * @param _askSecret - Asks the developer for a secret in the interface, such as the password of encrypted files.
   */
  constructor (
    private readonly _publish: (payload: EnvironmentPayload) => Promise<void>,
    private readonly _askSecret: (label: string) => Promise<string>
  ) {}

  /**
   * Takes the `auth` and `environment` sections of the configuration, connects the backends it
   * declares, replacing the previous ones, and schedules the pulls it declares.
   *
   * @param config - The raw configuration.
   */
  configure (config: RawConfig): void {
    for (const backend of this._backends.values()) {
      backend.close().catch((error: unknown) => logger.warn('Environment', 'Backend', `Not closed: ${error instanceof Error ? error.message : String(error)}`))
    }
    try {
      this._options = readEnvironmentOptions(config.environment)
      this._error = null
    } catch (error) {
      this._options = null
      this._error = error instanceof Error ? error.message : String(error)
    }
    this._context = createBackendContext(config, this._askSecret)
    this._backends = createBackends(this._options?.backends ?? [], this._context)

    for (const job of this._pullJobs) {
      job.stop()
    }
    this._pullJobs = []
    this._scheduleErrors = []
    for (const { path, cron } of this._options?.autoPulls ?? []) {
      if (!cron) {
        continue
      }
      try {
        const onError = (error: unknown): void => logger.warn('Environment', path, `Scheduled pull failed: ${error instanceof Error ? error.message : String(error)}`)
        this._pullJobs.push(new Cron(cron, { protect: true, catch: onError }, () => this.autoPull([path])))
      } catch {
        this._scheduleErrors.push(`${path}: invalid pull cron "${cron}"`)
        logger.warn('Environment', path, `Invalid pull cron "${cron}"`)
      }
    }
  }

  /**
   * Describes the current state, as last refreshed.
   *
   * @returns The state.
   */
  state (): EnvironmentPayload {
    const error = [this._error, ...this._scheduleErrors].filter(Boolean).join('; ') || null
    const backends = (this._options?.backends ?? []).map(backend => ({ name: backend.slug, type: backend.type, default: backend.slug === this._options?.defaultBackend, encrypted: backend.encryption !== null }))
    return { configured: this._backends.size > 0, backends, items: this._items, error, run: this._run }
  }

  /**
   * Gives the files of the environment synchronized with a backend among some local files.
   *
   * @param files - Absolute paths of local files.
   * @returns The paths in the environment of those it synchronizes.
   */
  synchronizedPaths (files: string[]): string[] {
    const options = this._options
    if (!options) {
      return []
    }
    return options.items.filter(item => item.kind === 'file' && files.includes(localPathOf(options.folder, item.path))).map(item => item.path)
  }

  /**
   * Pulls the items declared to be pulled when the server starts.
   */
  async pullAtStartup (): Promise<void> {
    await this.autoPull(this._options?.autoPulls.filter(autoPull => autoPull.startup).map(autoPull => autoPull.path) ?? [])
  }

  /**
   * Pulls items on their own: an item whose copy on its backend is missing or unchanged since the last
   * sync is left alone, one whose local copy changed since the last sync (or was never synchronized) is
   * skipped and reported, the others are pulled. Nothing happens while another run is in progress.
   *
   * @param paths - The paths of the items.
   */
  async autoPull (paths: string[]): Promise<void> {
    const environment = this.environment()
    if (!environment || !paths.length || (this._run && !this._run.finished)) {
      return
    }

    const targets: EnvironmentTarget[] = []
    const skipped: { path: string, detail: string }[] = []
    const { items } = await environment.describe()
    for (const { item, local, remote, synced } of items.filter(described => paths.includes(described.item.path))) {
      if (remote === null || remote === 'unknown' || (synced && (synced.remoteVersion ?? synced.remoteUpdatedAt.toISOString()) === (remote.version ?? remote.updatedAt.toISOString()))) {
        continue
      }
      if (local && local.updatedAt.getTime() !== synced?.localUpdatedAt.getTime()) {
        skipped.push({ path: item.path, detail: synced ? 'local copy changed since the last sync, pull it by hand' : 'local copy never synchronized, pull it by hand' })
        continue
      }
      targets.push({ path: item.path, tables: null })
    }
    if (targets.length || skipped.length) {
      await this.run('pull', targets, skipped)
    }
  }

  /**
   * Describes the items again and publishes the state.
   */
  async refresh (): Promise<void> {
    const environment = this.environment()
    if (environment) {
      const { items, errors } = await environment.describe()
      this._error = Object.entries(errors).map(([backend, message]) => `${backend}: ${message}`).join('; ') || null
      const folder = this._options?.folder ?? defaultEnvironmentFolder()
      this._items = await Promise.all(
        items.map(async ({ item, local, remote, synced }) => {
          const keyed = item.kind === 'file' && configFormatOf(item.path) !== null
          return {
            path: item.path,
            kind: item.kind,
            backend: item.backend,
            encrypted: item.encryption !== null,
            engine: item.kind === 'database' ? item.engine : null,
            container: item.kind === 'database' ? item.container : null,
            bucket: item.kind === 'bucket' ? item.bucket : null,
            redis: item.kind === 'redis' ? redisDatabaseName(item.url) : null,
            keyed,
            local: local ? copyPayload(local) : null,
            remote: remote === 'unknown' || remote === null ? remote : copyPayload(remote),
            synced: synced ? { localUpdatedAt: synced.localUpdatedAt.toISOString(), remoteUpdatedAt: synced.remoteUpdatedAt.toISOString() } : null,
            pem: item.kind === 'file' && !keyed && local ? await readPem(localPathOf(folder, item.path), local.size) : null
          }
        })
      )
    } else {
      this._items = []
    }

    await this._publish(this.state())
  }

  /**
   * Downloads the shared devtool configuration, which declares the environment, and publishes why
   * it could not be downloaded, if it could not.
   *
   * @returns True when the configuration was downloaded.
   */
  async pullSharedConfig (): Promise<boolean> {
    const environment = this.environment()
    const backend = this._options?.defaultBackend ?? null
    if (!environment || backend === null) {
      return false
    }

    try {
      const result = await environment.pull({ item: { kind: 'file', path: SHARED_CONFIG_PATH, backend, encryption: null, ignore: null }, tables: null })
      this._error = result.done ? null : `${SHARED_CONFIG_PATH} is not on ${backend}`
    } catch (error) {
      this._error = error instanceof Error ? error.message : String(error)
    }

    await this._publish(this.state())
    return this._error === null
  }

  /**
   * Lists the tables of the local database of an item, or the key groups of its local Redis database.
   *
   * @param path - The path of the item.
   * @returns The tables or key groups, or why they could not be listed.
   */
  async tables (path: string): Promise<EnvironmentTablesPayload> {
    const item = this._options?.items.find(candidate => candidate.path === path)
    if (!item || (item.kind !== 'database' && item.kind !== 'redis')) {
      return { path, tables: [], error: `${path} is not a database of the environment` }
    }

    try {
      return { path, tables: await listTables(item), error: null }
    } catch (error) {
      return { path, tables: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Lists the keys whose values differ between the local copy of a configuration file and the copy of its backend.
   *
   * @param path - The path of the item.
   * @returns The differing keys, or why they could not be listed.
   */
  async keys (path: string): Promise<EnvironmentKeysPayload> {
    const environment = this.environment()
    const item = this._options?.items.find(candidate => candidate.path === path)
    if (!environment || item?.kind !== 'file') {
      return { path, entries: [], error: `${path} is not a file of the environment` }
    }

    try {
      const differences = await environment.diffKeys(item)
      return {
        path,
        error: null,
        entries: differences.map(difference => ({
          path: difference.path,
          local: { present: difference.local !== undefined, value: difference.local ?? null },
          remote: { present: difference.remote !== undefined, value: difference.remote ?? null }
        }))
      }
    } catch (error) {
      return { path, entries: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Forgets the last run once it is finished and publishes the state.
   */
  async dismissRun (): Promise<void> {
    if (!this._run?.finished) {
      return
    }

    this._run = null
    await this._publish(this.state())
  }

  /**
   * Pulls or pushes items one after the other, publishing the progress of each, then describes the
   * items again. A request while a run is in progress does nothing.
   *
   * @param direction - Whether the copies of the backends replace the local ones, or the reverse.
   * @param targets - The items, with the tables of the databases and the keys of the configuration files.
   * @param skipped - Items reported as skipped in the run, with the reason.
   */
  async run (direction: 'pull' | 'push', targets: EnvironmentTarget[], skipped: { path: string, detail: string }[] = []): Promise<void> {
    const environment = this.environment()
    if (!environment || !this._options || (this._run && !this._run.finished)) {
      return
    }

    const steps: EnvironmentRunPayload['steps'] = [
      ...targets.map(target => ({ target: targetName(target), status: 'pending' as const, detail: null })),
      ...skipped.map(({ path, detail }) => ({ target: path, status: 'skipped' as const, detail }))
    ]
    const run: EnvironmentRunPayload = { direction, steps, finished: false }
    this._run = run
    await this._publish(this.state())

    for (const [index, target] of targets.entries()) {
      const item = this._options.items.find(candidate => candidate.path === target.path)
      run.steps[index] = { ...run.steps[index], status: 'running' }
      await this._publish(this.state())
      try {
        if (!item) {
          throw new Error(`${target.path} is not part of the environment`)
        }

        const selection: EnvironmentSelection = {
          item,
          tables: (item.kind === 'database' || item.kind === 'redis') && target.tables?.length ? target.tables : null,
          keys: item.kind === 'file' && target.keys ? target.keys : null
        }
        const result = await (direction === 'pull' ? environment.pull(selection) : environment.push(selection))
        run.steps[index] = { ...run.steps[index], status: result.done ? 'done' : 'skipped', detail: result.detail }
      } catch (error) {
        run.steps[index] = { ...run.steps[index], status: 'failed', detail: error instanceof Error ? error.message : String(error) }
      }
      await this._publish(this.state())
    }

    run.finished = true
    await this.refresh()
  }

  /**
   * Builds the environment of the configuration.
   *
   * @returns The environment, or null when the configuration declares none or no backend.
   */
  private environment (): Environment | null {
    return this._options && this._context && this._backends.size > 0 ? new Environment(this._backends, this._options, this._context) : null
  }
}
