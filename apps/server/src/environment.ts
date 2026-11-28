import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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
  DEVELOPER_ANSWER_MS,
  Environment,
  type EnvironmentBackend,
  type EnvironmentOptions,
  type EnvironmentSelection,
  listTables,
  localPathOf,
  readEnvironmentOptions,
  redisDatabaseName,
  sectionOf,
  SHARED_CONFIG_PATH,
  sharedConfigItem,
  TransferCancelledError,
  transfersParts,
  type TransferResult
} from '@appsys-sas/devtool-environment'
import { logger } from '@appsys-sas/devtool-shared'
import { Cron } from 'croner'
import type {
  EnvironmentAction,
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
 * their commands stopped when they do not answer within the time the developer has to answer, the
 * cache folder, the identity provider and a way to ask the developer for a secret.
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
    runShell: async command => (await execFileAsync('/bin/sh', ['-c', command], { cwd: configFolder, timeout: DEVELOPER_ANSWER_MS })).stdout,
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
 * @returns Its size, ISO date and version.
 */
function copyPayload (copy: CopyInfo): EnvironmentCopyPayload {
  return { size: copy.size, updatedAt: copy.updatedAt.toISOString(), version: copy.version ?? null }
}

const PEM_MAX_BYTES = 1024 * 1024
const PROGRESS_PUBLISH_MS = 200
const RUN_ACTIONS = new Set<string>(['pull', 'push', 'restore', 'remove'] satisfies EnvironmentAction[])

/**
 * Tells what a local PEM file holds: its first certificate, with the end of its validity, or a private key.
 *
 * @param filePath - The local file.
 * @param size - Its size, larger or unknown sizes being left unread.
 * @returns What it holds, null when it is no PEM file or cannot be read.
 */
async function readPem (filePath: string, size: number | null): Promise<EnvironmentPemPayload | null> {
  if (size === null || size > PEM_MAX_BYTES) {
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

/** The backends of a configuration, and how many operations use them. */
interface BackendSet {
  backends: Map<string, EnvironmentBackend>
  users: number
  /** Whether a newer configuration replaced them, so they close once unused. */
  replaced: boolean
}

/** An environment an operation uses, and the release of its backends once the operation ends. */
interface EnvironmentLease {
  environment: Environment
  release: () => void
}

/**
 * Closes backends no longer used, logging those that cannot be closed.
 *
 * @param backends - The backends.
 */
function closeBackends (backends: Iterable<EnvironmentBackend>): void {
  for (const backend of backends) {
    backend.close().catch((error: unknown) => logger.warn('Environment', 'Backend', `Not closed: ${error instanceof Error ? error.message : String(error)}`))
  }
}

/**
 * Development environment of the developer as the interface shows it: the items with their local
 * copies and the copies of their backends, and the pulls and pushes it starts, one at a time.
 */
export class DevtoolEnvironment {
  private _backends: BackendSet = { backends: new Map(), users: 0, replaced: false }
  private _context: BackendContext | null = null
  private _options: EnvironmentOptions | null = null
  private _items: EnvironmentItemPayload[] = []
  private _error: string | null = null
  private _run: EnvironmentRunPayload | null = null
  /** Cancels each step of the run in progress. */
  private _cancels: AbortController[] = []
  /** Counts the refreshes not finished. */
  private _refreshing = 0
  /** Counts the refreshes started. */
  private _refreshes = 0
  /** The latest refresh published, so an older one ending later never replaces its items. */
  private _publishedRefresh = 0
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
   * declares, replacing the previous ones, closed once no operation uses them, and schedules the
   * pulls it declares. A refresh started before never publishes its items.
   *
   * @param config - The raw configuration.
   */
  configure (config: RawConfig): void {
    this._publishedRefresh = ++this._refreshes
    const previous = this._backends
    previous.replaced = true
    if (previous.users === 0) {
      closeBackends(previous.backends.values())
    }
    try {
      this._options = readEnvironmentOptions(config.environment)
      this._error = null
    } catch (error) {
      this._options = null
      this._error = error instanceof Error ? error.message : String(error)
    }
    this._context = createBackendContext(config, this._askSecret)
    this._backends = { backends: createBackends(this._options?.backends ?? [], this._context), users: 0, replaced: false }

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
    return { configured: this._backends.backends.size > 0, backends, items: this._items, error, refreshing: this._refreshing > 0, run: this._run }
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
   * sync is left alone, one whose local copy changed since the last sync (or was never synchronized), or
   * that the groups of the developer do not let pull, is skipped and reported, the others are pulled.
   * Nothing happens while another run is in progress.
   *
   * @param paths - The paths of the items.
   */
  async autoPull (paths: string[]): Promise<void> {
    const lease = !paths.length || (this._run && !this._run.finished) ? null : this.lease()
    if (!lease) {
      return
    }

    const targets: EnvironmentTarget[] = []
    const skipped: { path: string, detail: string }[] = []
    try {
      const { items } = await lease.environment.describe()
      for (const { item, local, remote, synced } of items.filter(described => paths.includes(described.item.path))) {
        if (remote === null || remote === 'unknown' || (synced && (synced.remoteVersion ?? synced.remoteUpdatedAt.toISOString()) === (remote.version ?? remote.updatedAt.toISOString()))) {
          continue
        }
        if (local && local.updatedAt.getTime() !== synced?.localUpdatedAt.getTime()) {
          skipped.push({ path: item.path, detail: synced ? 'local copy changed since the last sync, pull it by hand' : 'local copy never synchronized, pull it by hand' })
          continue
        }
        const refusal = await lease.environment.refusal(item, 'pull')
        if (refusal !== null) {
          skipped.push({ path: item.path, detail: refusal })
          continue
        }
        targets.push({ path: item.path, tables: null })
      }
    } finally {
      lease.release()
    }
    if (targets.length || skipped.length) {
      await this.run('pull', targets, skipped)
    }
  }

  /**
   * Describes the items again, publishing that it does so, then the items unless a later refresh
   * already published its own, or why they could not be described.
   */
  async refresh (): Promise<void> {
    const generation = ++this._refreshes
    this._refreshing += 1
    try {
      await this._publish(this.state())
      const { items, error } = await this.describeItems()
      if (generation >= this._publishedRefresh) {
        this._publishedRefresh = generation
        this._error = error
        this._items = items
      }
    } catch (error) {
      if (generation >= this._publishedRefresh) {
        this._error = `the environment could not be described: ${error instanceof Error ? error.message : String(error)}`
      }
    } finally {
      this._refreshing -= 1
    }
    await this._publish(this.state())
  }

  /**
   * Describes the items for the interface.
   *
   * @returns The items, and why the copies of some backends are unknown, null when every copy is known.
   */
  private async describeItems (): Promise<{ items: EnvironmentItemPayload[], error: string | null }> {
    const lease = this.lease()
    try {
      return await this.describeWith(lease?.environment ?? null)
    } finally {
      lease?.release()
    }
  }

  /**
   * Describes the items of an environment for the interface.
   *
   * @param environment - The environment, null when the configuration declares none or no backend.
   * @returns The items, and why the copies of some backends are unknown, null when every copy is known.
   */
  private async describeWith (environment: Environment | null): Promise<{ items: EnvironmentItemPayload[], error: string | null }> {
    const options = this._options
    let items: EnvironmentItemPayload[] = []
    let error = this._error
    if (environment && options) {
      const described = await environment.describe()
      error = Object.entries(described.errors).map(([backend, message]) => `${backend}: ${message}`).join('; ') || null
      items = await Promise.all(
        described.items.map(async ({ item, local, remote, synced }) => {
          const keyed = item.kind === 'file' && configFormatOf(item.path) !== null
          return {
            path: item.path,
            kind: item.kind,
            section: sectionOf(options.sections, item),
            backend: item.backend,
            encrypted: item.encryption !== null,
            engine: item.kind === 'database' ? item.engine : null,
            container: item.kind === 'database' ? item.container : null,
            database: item.kind === 'database' ? item.database : null,
            bucket: item.kind === 'bucket' ? item.bucket : null,
            parts: { pull: transfersParts(item, 'pull'), push: transfersParts(item, 'push') },
            allowed: { pull: await environment.refusal(item, 'pull') === null, push: await environment.refusal(item, 'push') === null },
            redis: item.kind === 'redis' ? redisDatabaseName(item.url) : null,
            keyed,
            local: local ? copyPayload(local) : null,
            remote: remote === 'unknown' || remote === null ? remote : copyPayload(remote),
            synced: synced ? { localUpdatedAt: synced.localUpdatedAt.toISOString(), remoteUpdatedAt: synced.remoteUpdatedAt.toISOString() } : null,
            pem: item.kind === 'file' && !keyed && local ? await readPem(localPathOf(options.folder, item.path), local.size) : null
          }
        })
      )
    }
    return { items, error }
  }

  /**
   * Downloads the shared devtool configuration, which declares the environment, and publishes why
   * it could not be downloaded, if it could not.
   *
   * @returns True when the configuration was downloaded.
   */
  async pullSharedConfig (): Promise<boolean> {
    const item = this._options && sharedConfigItem(this._options)
    const lease = item ? this.lease() : null
    if (!lease || !item) {
      return false
    }

    try {
      const result = await lease.environment.pull({ item, tables: null })
      this._error = result.done ? null : `${SHARED_CONFIG_PATH} is not on ${item.backend}`
    } catch (error) {
      this._error = error instanceof Error ? error.message : String(error)
    } finally {
      lease.release()
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
    const item = this._options?.items.find(candidate => candidate.path === path)
    if (item?.kind !== 'file') {
      return { path, entries: [], error: `${path} is not a file of the environment` }
    }
    const lease = this.lease()
    if (!lease) {
      return { path, entries: [], error: 'the environment declares no backend it can use' }
    }

    try {
      const differences = await lease.environment.diffKeys(item)
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
    } finally {
      lease.release()
    }
  }

  /**
   * Forgets a run once it is finished and publishes the state; nothing happens for another run than
   * the last one.
   *
   * @param runId - The run.
   */
  async dismissRun (runId: string): Promise<void> {
    if (this._run?.id !== runId || !this._run.finished) {
      return
    }

    this._run = null
    await this._publish(this.state())
  }

  /**
   * Cancels the transfer of items of the pull or push in progress: the item whose file moves is left
   * as it was, an item waiting is skipped at once, and an item whose restore started or whose file
   * is stored runs to its end. Nothing happens outside a pull or push in progress, nor for another
   * run than the one in progress.
   *
   * @param runId - The run.
   * @param index - The step of the item, null for every step not finished.
   */
  cancel (runId: string, index: number | null): void {
    const run = this._run
    if (run?.id !== runId || (run.action !== 'pull' && run.action !== 'push') || run.finished) {
      return
    }
    let skipped = false
    for (const [step, cancel] of this._cancels.entries()) {
      if (index === null || index === step) {
        cancel.abort(new Error('cancelled'))
        if (run.steps[step].status === 'pending') {
          run.steps[step] = { ...run.steps[step], status: 'skipped', detail: 'cancelled', progress: null }
          skipped = true
        }
      }
    }
    if (skipped) {
      this._publish(this.state()).catch((error: unknown) => logger.warn('Environment', 'Cancel', `Not published: ${error instanceof Error ? error.message : String(error)}`))
    }
  }

  /**
   * Runs an action over items one after the other, publishing the progress of each and the end of
   * the run, then describes the items again. The run starts before the call returns, `state()` then
   * giving it as the run in progress, and always ends, every step in a final state, even when the
   * configuration changes meanwhile. A request while a run is in progress, or for an unknown action,
   * does nothing.
   *
   * @param action - Pull or push the items, restore their local data from their local copies, or remove those copies.
   * @param targets - The items, with the tables of the databases and the keys of the configuration files.
   * @param skipped - Items reported as skipped in the run, with the reason.
   */
  async run (action: EnvironmentAction, targets: EnvironmentTarget[], skipped: { path: string, detail: string }[] = []): Promise<void> {
    const items = this._options?.items
    if (!RUN_ACTIONS.has(action)) {
      logger.warn('Environment', 'Run', `Unknown action ${JSON.stringify(action)}`)
      return
    }
    if (!items || (this._run && !this._run.finished)) {
      return
    }
    const steps: EnvironmentRunPayload['steps'] = [
      ...targets.map(target => ({ target: targetName(target), status: 'pending' as const, detail: null, progress: null })),
      ...skipped.map(({ path, detail }) => ({ target: path, status: 'skipped' as const, detail, progress: null }))
    ]
    const lease = this.lease()
    if (!lease) {
      return
    }
    const { environment } = lease
    const actions: Record<EnvironmentAction, (selection: EnvironmentSelection) => Promise<TransferResult>> = {
      pull: async selection => environment.pull(selection),
      push: async selection => environment.push(selection),
      restore: async selection => environment.restoreLocal(selection),
      remove: async selection => environment.removeLocalCopy(selection)
    }
    const run: EnvironmentRunPayload = { id: randomUUID(), action, steps, finished: false }
    const cancels = targets.map(() => new AbortController())
    this._run = run
    this._cancels = cancels

    let pendingPublish: NodeJS.Timeout | undefined
    try {
      await this._publish(this.state())
      for (const [index, target] of targets.entries()) {
        const { signal } = cancels[index]
        if (run.steps[index].status !== 'pending') {
          continue
        }
        try {
          run.steps[index] = { ...run.steps[index], status: 'running' }
          await this._publish(this.state())
          if (signal.aborted) {
            throw new TransferCancelledError(target.path)
          }
          const item = items.find(candidate => candidate.path === target.path)
          if (!item) {
            throw new Error(`${target.path} is not part of the environment`)
          }
          const tables = action === 'remove' ? null : target.tables ?? null
          if (tables !== null && item.kind !== 'database' && item.kind !== 'redis') {
            throw new Error(`${target.path} has no tables or key groups to choose from`)
          }
          if (tables?.length === 0) {
            throw new Error(`no table or key group chosen for ${target.path}`)
          }

          const result = await actions[action]({
            item,
            tables,
            keys: item.kind === 'file' && target.keys ? target.keys : null,
            signal,
            onProgress: (done, total) => {
              if (run.steps[index].status !== 'running') {
                return
              }
              run.steps[index] = { ...run.steps[index], progress: { done, total } }
              pendingPublish ??= setTimeout(() => {
                pendingPublish = undefined
                this._publish(this.state()).catch((error: unknown) => logger.warn('Environment', 'Progress', `Not published: ${error instanceof Error ? error.message : String(error)}`))
              }, PROGRESS_PUBLISH_MS)
            }
          })
          run.steps[index] = { ...run.steps[index], status: result.done ? 'done' : 'skipped', detail: result.detail, progress: null }
        } catch (error) {
          const cancelled = error instanceof TransferCancelledError
          const detail = cancelled ? 'cancelled' : error instanceof Error ? error.message : String(error)
          run.steps[index] = { ...run.steps[index], status: cancelled ? 'skipped' : 'failed', detail, progress: null }
        }
        clearTimeout(pendingPublish)
        pendingPublish = undefined
        await this._publish(this.state())
      }
    } finally {
      clearTimeout(pendingPublish)
      run.steps = run.steps.map(step => (step.status === 'pending' || step.status === 'running' ? { ...step, status: 'failed', detail: 'the run stopped before this item', progress: null } : step))
      run.finished = true
      this._cancels = []
      lease.release()
      await this._publish(this.state())
    }
    await this.refresh()
  }

  /**
   * Builds the environment of the configuration for an operation, whose backends stay open until
   * the operation releases them, even when a new configuration replaces them meanwhile.
   *
   * @returns The environment and its release, or null when the configuration declares none or no backend.
   */
  private lease (): EnvironmentLease | null {
    const set = this._backends
    if (!this._options || !this._context || set.backends.size === 0) {
      return null
    }
    set.users += 1
    let released = false
    return {
      environment: new Environment(set.backends, this._options, this._context),
      release: () => {
        if (released) {
          return
        }
        released = true
        set.users -= 1
        if (set.replaced && set.users === 0) {
          closeBackends(set.backends.values())
        }
      }
    }
  }
}
