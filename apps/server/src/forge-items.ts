import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ForgeItemsPayload, ForgeTimelinePayload, ForgeKind, IntegrationDefinition, RuntimeConfig } from '@appsys-sas/devtool-shared'
import { integrationKey, logger } from '@appsys-sas/devtool-shared'
import { findForge, ForgeError, type GitForge, repositoryOf, type ForgeRepository } from '@appsys-sas/devtool-git'
import { type AuthReader, type CommandAutomation, CommandSecrets } from './command-automation.js'
import { integrationAutomationKey } from './configure.js'

const execFileAsync = promisify(execFile)
const MINUTE_MS = 60_000
/** How many of the last events of a timeline are read first, the others on demand. */
const TIMELINE_LAST = 30

/** What the items of the forges need from the server. */
export interface ForgeItemsHost {
  /** Sends the state to every connected interface. */
  publish: (payload: ForgeItemsPayload[]) => Promise<void>
  /** Reads the values of the signed-in developer for the value blocks of the tokens. */
  readAuth: AuthReader
}

/** An integration listing what a forge holds, with what reading it needs. */
interface ForgeSource {
  integration: IntegrationDefinition
  kind: ForgeKind
  /** The folder of the section or project declaring it, where the value blocks of the token are read. */
  folder: string
  /** The token, its value blocks not read yet, null for none. */
  token: string | null
  automation: CommandAutomation | null
}

/**
 * The open pull requests and issues of the integrations listing them, read on demand and every
 * `refresh` minutes once an interface asked for them, and the timeline of an item when asked for,
 * each token read once until the configuration changes or the forge refuses it.
 */
export class DevtoolForgeItems {
  private _sources = new Map<string, ForgeSource>()
  private readonly _states = new Map<string, ForgeItemsPayload>()
  private readonly _tokens = new Map<string, Promise<string | null>>()
  private _timers: NodeJS.Timeout[] = []
  private _started = false

  /**
   * @param _host What the items of the forges need from the server.
   */
  constructor (private readonly _host: ForgeItemsHost) {}

  /**
   * Takes the integrations of the configuration, reading their items again once started.
   * @param config The runtime configuration.
   * @param automations The automations of the configuration.
   * @param tokens The tokens of the integrations, by key.
   */
  configure (config: RuntimeConfig, automations: Record<string, CommandAutomation>, tokens: Record<string, string>): void {
    this._sources = new Map()
    for (const section of Object.values(config.projects)) {
      for (const owner of [{ project: null, path: section.path, integrations: section.integrations }, ...Object.values(section.directories).map(directory => ({ project: directory.slug, path: directory.path, integrations: directory.integrations }))]) {
        for (const integration of owner.integrations) {
          if (integration.type !== 'web') {
            const key = integrationKey(section.slug, owner.project, integration.slug)
            this._sources.set(key, { integration, kind: integration.type, folder: owner.path, token: tokens[key] ?? null, automation: automations[integrationAutomationKey(key)] ?? null })
          }
        }
      }
    }
    for (const key of this._states.keys()) {
      if (this._sources.get(key)?.kind !== this._states.get(key)?.kind) {
        this._states.delete(key)
      }
    }
    for (const [key, source] of this._sources) {
      if (!this._states.has(key)) {
        this._states.set(key, { key, kind: source.kind, items: [], viewer: null, updatedAt: null, loading: false, error: null })
      }
    }
    this._tokens.clear()
    if (this._started) {
      this._started = false
      this.start()
    } else {
      void this.publish()
    }
  }

  /**
   * Reads every item now, then every `refresh` minutes of its integration; does nothing once started.
   */
  start (): void {
    if (this._started) {
      return
    }
    this._started = true
    this._timers.forEach(timer => clearInterval(timer))
    this._timers = []
    for (const [key, source] of this._sources) {
      if (source.integration.refresh > 0) {
        this._timers.push(setInterval(() => void this.refresh(key), source.integration.refresh * MINUTE_MS).unref())
      }
      void this.refresh(key)
    }
  }

  /**
   * Describes the items of every integration, as last read.
   * @returns The state.
   */
  state (): ForgeItemsPayload[] {
    return [...this._states.values()]
  }

  /**
   * Reads the items of an integration now, unless a read is running.
   * @param key The integration, `<section>[/<project>]/<slug>`.
   */
  async refresh (key: string): Promise<void> {
    const source = this._sources.get(key)
    const state = this._states.get(key)
    if (!source || !state || state.loading) {
      return
    }

    this._states.set(key, { ...state, loading: true })
    await this.publish()
    let next: ForgeItemsPayload
    try {
      const { repository, forge } = this.forgeOf(source)
      const token = await this.token(key, source)
      const common = { key, updatedAt: new Date().toISOString(), loading: false, error: null }
      next = source.kind === 'pullRequests' ? { ...common, kind: 'pullRequests', ...(await forge.pullRequests(repository, token)) } : { ...common, kind: 'issues', ...(await forge.issues(repository, token)) }
    } catch (error) {
      next = { ...state, loading: false, error: this.failure(key, error) }
    }
    if (this._sources.get(key) === source) {
      this._states.set(key, next)
      await this.publish()
    }
  }

  /**
   * Reads a part of the timeline of an item of an integration: its last events, or every event before
   * a place a previous part gave.
   * @param key The integration, `<section>[/<project>]/<slug>`.
   * @param number The number of the item.
   * @param before Where the events read start, null for the last events.
   * @returns What happened to it, or why it could not be read.
   */
  async timeline (key: string, number: number, before: string | null): Promise<ForgeTimelinePayload> {
    const payload = { key, number, previous: before !== null }
    const source = this._sources.get(key)
    if (!source) {
      return { ...payload, events: [], before: null, remaining: 0, error: `no integration ${key}` }
    }
    try {
      const { repository, forge } = this.forgeOf(source)
      const page = before === null ? { last: TIMELINE_LAST } : { before }
      return { ...payload, ...(await forge.timeline(repository, await this.token(key, source), source.kind, number, page)), error: null }
    } catch (error) {
      return { ...payload, events: [], before, remaining: 0, error: this.failure(key, error) }
    }
  }

  /**
   * Gives the repository of an integration and the forge hosting it.
   * @param source The integration.
   * @returns The repository and its forge.
   * @throws {Error} When no forge hosts it.
   */
  private forgeOf (source: ForgeSource): { repository: ForgeRepository, forge: GitForge } {
    const repository = repositoryOf(source.integration.url)
    const forge = repository ? findForge(source.integration.provider?.name ?? null, repository) : null
    if (!repository || !forge) {
      throw new Error(`no forge for ${source.integration.url}`)
    }
    return { repository, forge }
  }

  /**
   * Describes a failure of a forge, forgetting the token it refused.
   * @param key The integration.
   * @param error The failure.
   * @returns Its message.
   */
  private failure (key: string, error: unknown): string {
    if (error instanceof ForgeError && error.status === 401) {
      this._tokens.delete(key)
    }
    const message = error instanceof Error ? error.message : String(error)
    logger.warn('Forges', key, message)
    return message
  }

  /**
   * Gives the token of an integration, its value blocks read on first use.
   * @param key The integration.
   * @param source What reading its items needs.
   * @returns The token, null when the integration declares none.
   */
  private token (key: string, source: ForgeSource): Promise<string | null> {
    let token = this._tokens.get(key)
    if (!token) {
      token = this.readToken(source)
      token.catch(() => this._tokens.delete(key))
      this._tokens.set(key, token)
    }
    return token
  }

  /**
   * Reads the value blocks of the token of an integration, in the folder of its owner.
   * @param source What reading its items needs.
   * @returns The token, null when the integration declares none.
   */
  private async readToken (source: ForgeSource): Promise<string | null> {
    if (source.token === null) {
      return null
    }
    const secrets = new CommandSecrets({
      account: source.automation?.opAccount ?? null,
      folder: source.folder,
      runShell: async command => (await execFileAsync('/bin/sh', ['-c', command], { cwd: source.folder })).stdout,
      readAuth: this._host.readAuth
    })
    try {
      return await secrets.resolve(source.token)
    } finally {
      secrets.close()
    }
  }

  /**
   * Sends the state to every connected interface.
   */
  private async publish (): Promise<void> {
    await this._host.publish(this.state())
  }
}
