import path from 'node:path'
import fs from 'node:fs/promises'
import net from 'node:net'
import type { AgentAction, AgentDefinition, CertificateAcme, ForgeKind, ClientConfigPayload, CommandArg, CommandChoice, CommandForm, CommandInput, DirectoryDefinition, DirectoryFiles, DirectoryFilesType, DirectoryScripts, ScriptSettings, AdtDefinition, DirectoryDefaultAction, DirectoryShortcut, DnsDefinition, DnsRecord, DnsServerAddress, HostAccess, IntegrationDefinition, IntegrationType, LoadBalancerCertificate, McpCategory, McpEnvironmentItem, McpPatterns, McpRules, McpSettings, McpTarget, PassthroughRule, ProjectDefinition, ProjectRestore, RuntimeConfig, SidebarSettings, SortMode } from '@appsys-sas/devtool-shared'
import { AGENT_ACTIONS, DEFAULT_AGENT_PROMPTS, defaultMcpRules, integrationKey, isMcpLevel, logger, readMcpRules, shortcutKey, SORT_MODES, sortKeys } from '@appsys-sas/devtool-shared'
import { type AuthOptions, readAuthOptions } from '@appsys-sas/devtool-auth'
import { readBackends } from '@appsys-sas/devtool-environment'
import { type LegoOptionValue, legoRunArgs } from '@appsys-sas/devtool-certs'
import { configSourceKey, resolveAppIdentity, resolveCacheFolder } from '@appsys-sas/devtool-config'
import { FORGES, findForge, originUrl, repositoryOf } from '@appsys-sas/devtool-git'
import { type CommandAnswer, type CommandAutomation, findInvalidValueBlocks } from './command-automation.js'
import { listScripts } from './scripts.js'
import type { ConfigOrigin } from './types.js'
import { isObject, toCommandArgsArray, toRecord, toStringArray, toStringRecord } from './utils.js'

const SLUG_REGEXP = /^[a-zA-Z0-9\-/_.]+$/i
/** Options of `lego run` the devtool sets itself. */
const LEGO_OWNED_OPTIONS = ['path', 'cert.name', 'accept-tos', 'renew-force', 'renew-days', 'no-random-sleep']

/**
 * Names the automation of the renewal of a certificate among the automations of the configuration.
 * @param name The name of the certificate in the configuration.
 * @returns The key of its automation.
 */
export function certificateAutomationKey (name: string): string {
  return `loadBalancers/${name}/acme`
}

/**
 * Names the automation reading the token of an integration among the automations of the configuration.
 * @param key The integration, `<section>[/<project>]/<slug>`.
 * @returns The key of its automation.
 */
export function integrationAutomationKey (key: string): string {
  return `integrations/${key}`
}

/**
 * Names the automation of an agent among the automations of the configuration.
 * @param slug The slug of the agent.
 * @returns The key of its automation.
 */
export function agentAutomationKey (slug: string): string {
  return `agents/${slug}`
}
const HOST_PATTERN_REGEXP = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/
const DNS_SERVER_REGEXP = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9-]+(?:\.[a-z0-9-]+)*))(?::(\d{1,5}))?$/i
const DEFAULT_INTEGRATION_ICON = 'lucide:app-window'
const DEFAULT_FORGE_ICONS: Record<ForgeKind, string> = { pullRequests: 'lucide:git-pull-request', issues: 'lucide:circle-dot' }
/** The setting turning on each action of agents on the items of an integration. */
const AGENT_ACTION_SETTINGS: Record<AgentAction, string> = { review: 'agentReview', analyze: 'agentAnalyze', fix: 'agentFix' }
const FORGE_KINDS: readonly ForgeKind[] = ['pullRequests', 'issues']
const DEFAULT_AGENT_ICON = 'lucide:bot'
const INTEGRATION_TYPES: readonly IntegrationType[] = ['web', ...FORGE_KINDS]
/** The optional parts of the sidebar, each shown or hidden. */
const SIDEBAR_PARTS = ['environment', 'configs', 'login'] as const satisfies readonly (keyof SidebarSettings)[]

/**
 * Gives the settings of the devtool before the configuration is read.
 * @returns The default settings.
 */
function defaultAdt (): AdtDefinition {
  return {
    ...resolveAppIdentity({}).identity,
    host: null,
    cacheDir: resolveCacheFolder({}),
    shell: null,
    ports: {
      server: 6730,
      loadBalancer: 6731
    },
    notifications: true,
    access: 'local',
    sidebar: { environment: false, configs: false, login: false, sort: 'config', order: [], sections: [] },
    mcp: defaultMcpSettings(true),
    agents: []
  }
}

/**
 * Gives the MCP server settings before the configuration is read: off, unknown agents asked for, the
 * command lines outside the configuration refused.
 * @param notifications Whether the interfaces notify the requests of agents.
 * @returns The default settings.
 */
function defaultMcpSettings (notifications: boolean): McpSettings {
  const rules = defaultMcpRules('default')
  return {
    enabled: false,
    notifications,
    skills: true,
    timeout: 120,
    default: rules,
    commands: rules,
    scripts: rules,
    files: rules,
    terminals: rules,
    certificates: rules,
    devtool: rules,
    integrations: rules,
    clients: { level: 'ask', allow: [], deny: [] },
    ownTerminals: 'allow',
    shell: { level: 'deny', allow: [], deny: [] },
    environment: rules,
    environmentItems: []
  }
}

/** The lists of items of the environment, with the kind of their items. */
const ENVIRONMENT_LISTS = { files: 'file', databases: 'database', buckets: 'bucket', redis: 'redis' } as const

/** The categories of `adt.mcp` refining `adt.mcp.default`. */
const MCP_CATEGORIES: readonly McpCategory[] = ['commands', 'scripts', 'files', 'terminals', 'certificates', 'devtool', 'integrations']
const FILES_TYPES: readonly DirectoryFilesType[] = ['files', 'agentSkills']

/** What shortcuts may name: the integrations of a project, and the commands, files and services of a directory. */
type ShortcutOwner = Pick<DirectoryDefinition, 'integrations'> & Partial<Pick<DirectoryDefinition, 'extras' | 'files' | 'loadBalancer'>>

/** The section or the project of a section declaring integrations, and its folder. */
interface IntegrationOwner {
  path: string
  section: string
  /** The project, null for the section itself. */
  project: string | null
  /** The `mcp` settings of the section and the project, applied over `adt.mcp.integrations`. */
  layers: McpLayer[]
}

/** An `mcp` setting declared by something holding others, applied over the rules of what it holds. */
interface McpLayer {
  value: unknown
  fromPath: string[]
}
const SIGNAL_REGEXP = /^SIG[A-Z0-9]+$/

export class DevtoolConfigure {
  private readonly initialConfig: Record<string, unknown>

  public adt: AdtDefinition

  public loadBalancers: Record<string, LoadBalancerCertificate>

  public projects: Record<string, ProjectDefinition>

  /** What the server does around the commands, by `<project>/<directory>/<command>`, never sent to the interfaces. */
  public automations: Record<string, CommandAutomation>

  public warnings: string[]

  /** Hosts whose TLS connections the load balancer forwards untouched. */
  public passthrough: PassthroughRule[]

  public dns: DnsDefinition | null

  public integrations: IntegrationDefinition[]

  /** The tokens of the integrations, value blocks not read yet, by `<section>[/<project>]/<slug>`, never sent to the interfaces. */
  public integrationTokens: Record<string, string>

  /** The identity provider signing the developers in, null when the configuration declares none. */
  public auth: AuthOptions | null

  /** The prompts of the actions of agents by kind of items, `adt.agentPrompts`, over those of the devtool. */
  private agentPrompts: Partial<Record<ForgeKind, Partial<Record<AgentAction, string>>>>

  /** Where the settings of the configuration come from. */
  private readonly origin: ConfigOrigin

  /**
   * @param config The raw configuration.
   * @param origin Where its settings come from, for the settings changed from the interface.
   */
  constructor (config: Record<string, unknown>, origin: ConfigOrigin = { sources: {}, localPath: null, sharedPath: null }) {
    this.initialConfig = config
    this.origin = origin
    this.adt = defaultAdt()
    this.loadBalancers = {}
    this.passthrough = []
    this.dns = null
    this.integrations = []
    this.integrationTokens = {}
    this.auth = null
    this.agentPrompts = {}
    this.projects = {}
    this.automations = {}
    this.warnings = []
  }

  /**
   * Gives the configuration the server runs with.
   * @returns The configuration read last.
   */
  get runtimeConfig (): RuntimeConfig {
    return {
      adt: this.adt,
      loadBalancers: this.loadBalancers,
      passthrough: this.passthrough,
      dns: this.dns,
      integrations: this.integrations,
      projects: this.projects,
      warnings: this.warnings
    }
  }

  /**
   * Gives the part of the configuration the interfaces see.
   * @param version The version of the devtool.
   * @returns The configuration sent to the interfaces.
   */
  getForClient (version: string): ClientConfigPayload {
    return {
      version,
      name: this.adt.name,
      displayName: this.adt.displayName,
      warnings: this.warnings,
      loadBalancers: Object.keys(this.loadBalancers),
      integrations: this.integrations,
      projects: this.projects,
      sidebar: this.adt.sidebar,
      agents: this.adt.agents,
      mcp: {
        ...this.adt.mcp,
        port: this.adt.ports.server,
        certificatesByName: Object.fromEntries(Object.entries(this.loadBalancers).map(([domain, certificate]) => [domain.replace(/^\./, ''), { rules: certificate.mcp, target: certificate.mcpTarget }])),
        targets: this.settingTargets(),
        localFile: this.origin.localPath
      }
    }
  }

  /**
   * Gives where the MCP settings of `adt.mcp` and `environment` are written.
   * @returns The settings and the files declaring them.
   */
  private settingTargets (): ClientConfigPayload['mcp']['targets'] {
    return {
      default: this.settingTarget(['adt', 'mcp', 'default']),
      ...(Object.fromEntries(MCP_CATEGORIES.map(category => [category, this.settingTarget(['adt', 'mcp', category])])) as Record<McpCategory, McpTarget>),
      ownTerminals: this.settingTarget(['adt', 'mcp', 'ownTerminals']),
      shell: this.settingTarget(['adt', 'mcp', 'shell', 'level']),
      clients: this.settingTarget(['adt', 'mcp', 'clients', 'level']),
      environment: this.settingTarget(['environment', 'mcp'])
    }
  }

  /**
   * Gives the personal override the interfaces write their changes to by default.
   * @returns Its path, null when none is loaded.
   */
  get localPath (): string | null {
    return this.origin.localPath
  }

  /**
   * Finds where an MCP setting of the configuration is written, among the settings the interfaces may
   * change: those of `adt.mcp` and `environment`, and of the items of the environment, certificates,
   * sections, projects, commands, folders of scripts, scripts and folders of files.
   * @param settingPath The keys leading to the setting.
   * @returns The setting and the file declaring it, null when it is not one of them.
   */
  findMcpTarget (settingPath: string[]): McpTarget | null {
    const directories = Object.values(this.projects).flatMap(project => Object.values(project.directories))
    const targets = [
      ...Object.values(this.settingTargets()),
      ...Object.values(this.loadBalancers).map(certificate => certificate.mcpTarget),
      ...this.adt.mcp.environmentItems.map(item => item.target),
      ...Object.values(this.projects).map(project => project.mcpTarget),
      ...directories.flatMap(directory => [
        directory.mcpTarget,
        ...Object.values(directory.extras).map(extra => extra.mcpTarget),
        ...directory.scripts.map(folder => folder.mcpTarget),
        ...Object.values(directory.files).map(files => files.mcpTarget)
      ]),
      ...[...Object.values(this.projects), ...directories].flatMap(owner => owner.integrations.flatMap(integration => (integration.mcpTarget ? [integration.mcpTarget] : [])))
    ]
    return targets.find(target => target.path.length === settingPath.length && target.path.every((key, index) => key === settingPath[index])) ?? null
  }

  /**
   * Gives where a setting is written: the last file declaring it, else the first file declaring what
   * holds it, the personal override left out, else the first shared configuration file.
   * @param settingPath The keys leading to the setting in the configuration files.
   * @returns The setting and the file declaring it.
   */
  settingTarget (settingPath: string[]): McpTarget {
    const declaring = (keys: string[]): string[] => (this.origin.sources[configSourceKey(keys)] ?? []).filter(file => file !== this.origin.localPath)
    const own = declaring(settingPath).at(-1)
    if (own) {
      return { path: settingPath, declaredIn: own }
    }
    for (let length = settingPath.length - 1; length > 0; length -= 1) {
      const holder = declaring(settingPath.slice(0, length))[0]
      if (holder) {
        return { path: settingPath, declaredIn: holder }
      }
    }
    return { path: settingPath, declaredIn: this.origin.sharedPath }
  }

  /**
   * Reads the raw configuration again from scratch, every invalid setting becoming a warning.
   */
  async reconfigure (): Promise<void> {
    this.adt = defaultAdt()
    this.loadBalancers = {}
    this.passthrough = []
    this.dns = null
    this.integrations = []
    this.integrationTokens = {}
    this.agentPrompts = {}
    this.projects = {}
    this.automations = {}
    this.warnings = []

    try {
      await this.reconfigureAdt()
    } catch (error) {
      this.addWarning('adt', error instanceof Error ? error.message : 'Unknown adt error')
    }
    this.adt.mcp = this.readMcp(toRecord(this.initialConfig.adt).mcp)

    try {
      this.reconfigureLoadBalancers()
    } catch (error) {
      this.addWarning('loadBalancers', error instanceof Error ? error.message : 'Unknown load balancer error')
    }

    const auth = readAuthOptions(this.initialConfig.auth)
    this.auth = auth.options
    for (const problem of auth.problems) {
      this.addWarning(problem.setting, problem.message)
    }
    if (this.initialConfig.cdn !== undefined) {
      this.addWarning('cdn', 'is replaced by a backend of the environment: environment.backends.<name> { type: cdn, url }')
    }
    const { backends, problems: backendProblems } = readBackends(toRecord(this.initialConfig.environment).backends)
    for (const problem of backendProblems) {
      this.addWarning(problem.setting, problem.message)
    }
    for (const backend of backends.filter(candidate => candidate.type === 'cdn' && this.auth === null)) {
      this.addWarning(`environment.backends.${backend.slug}`, 'a cdn backend needs an auth section, signing the developers in')
    }

    this.passthrough = this.readPassthrough('passthrough', this.initialConfig.passthrough)
    this.dns = this.readDns('dns', this.initialConfig.dns)
    this.integrations = this.readIntegrations('integrations', this.initialConfig.integrations, null)

    try {
      await this.reconfigureProjects()
    } catch (error) {
      this.addWarning('projects', error instanceof Error ? error.message : 'Unknown projects error')
    }
    this.adt.sidebar.sections = this.sortItems(
      'adt.sidebar.order',
      Object.values(this.projects).map(project => ({ key: project.slug, name: project.name })),
      this.adt.sidebar
    )
  }

  /**
   * Reads the settings of the devtool itself, `adt`: its host, interface, cache, names, icon, shell, ports,
   * access, the optional parts of its sidebar and its agents.
   */
  private async reconfigureAdt (): Promise<void> {
    const adt = toRecord(this.initialConfig.adt)
    if (Object.keys(adt).length === 0) {
      return
    }

    if (typeof adt.host === 'string') {
      this.adt.host = adt.host
    }

    if (typeof adt.uiPath === 'string') {
      this.adt.uiPath = adt.uiPath
    }
    this.adt.cacheDir = resolveCacheFolder(this.initialConfig)

    const { identity, problems } = resolveAppIdentity(this.initialConfig)
    Object.assign(this.adt, identity)
    for (const problem of problems) {
      this.addWarning(problem.setting, problem.message)
    }
    if (identity.icon && !(await fs.stat(identity.icon).then(stat => stat.isFile(), () => false))) {
      this.addWarning('adt.icon', `${identity.icon} does not exist`)
      this.adt.icon = null
    }

    const adtShell = this.readShell('adt.shell', adt.shell)
    if (adtShell !== null) {
      this.adt.shell = adtShell
    }

    if (isObject(adt.ports)) {
      if (Number.isInteger(adt.ports.server) && (adt.ports.server as number) > 0) {
        this.adt.ports.server = adt.ports.server as number
      }
      if (Number.isInteger(adt.ports.loadBalancer) && (adt.ports.loadBalancer as number) > 0) {
        this.adt.ports.loadBalancer = adt.ports.loadBalancer as number
      }
    }

    if (adt.notifications === true || adt.notifications === false) {
      this.adt.notifications = adt.notifications
    }

    this.adt.access = this.readAccess('adt.access', adt.access)

    const sidebar = toRecord(adt.sidebar)
    for (const key of SIDEBAR_PARTS) {
      if (sidebar[key] === true || sidebar[key] === false) {
        this.adt.sidebar[key] = sidebar[key]
      } else if (sidebar[key] !== undefined) {
        this.addWarning(`adt.sidebar.${key}`, 'is not a boolean')
      }
    }
    Object.assign(this.adt.sidebar, this.readSort('adt.sidebar', sidebar, 'config'))

    this.adt.agents = this.readAgents(adt.agents)
    const agentPrompts = adt.agentPrompts === undefined || isObject(adt.agentPrompts) ? toRecord(adt.agentPrompts) : null
    if (!agentPrompts) {
      this.addWarning('adt.agentPrompts', 'must be a map of prompts by kind of integration')
    }
    for (const [kind, prompts] of Object.entries(agentPrompts ?? {})) {
      if (FORGE_KINDS.includes(kind as ForgeKind)) {
        this.agentPrompts[kind as ForgeKind] = this.readAgentPrompts(`adt.agentPrompts.${kind}`, kind as ForgeKind, prompts)
      } else {
        this.addWarning(`adt.agentPrompts.${kind}`, `is not a kind of integration, expected ${FORGE_KINDS.join(' or ')}`)
      }
    }
  }

  /**
   * Reads the MCP server settings, `adt.mcp`, and the rules of the environment, `environment.mcp`.
   * @param value The raw `adt.mcp`.
   * @returns The settings, defaults for what is missing or invalid.
   */
  private readMcp (value: unknown): McpSettings {
    const settings = defaultMcpSettings(this.adt.notifications)
    const mcp = toRecord(value)
    for (const key of ['enabled', 'notifications', 'skills'] as const) {
      if (mcp[key] === true || mcp[key] === false) {
        settings[key] = mcp[key]
      } else if (mcp[key] !== undefined) {
        this.addWarning(`adt.mcp.${key}`, 'is not a boolean')
      }
    }
    if (mcp.timeout !== undefined) {
      if (Number.isInteger(mcp.timeout) && (mcp.timeout as number) > 0) {
        settings.timeout = mcp.timeout as number
      } else {
        this.addWarning('adt.mcp.timeout', 'must be a positive number of seconds')
      }
    }
    if (mcp.ownTerminals === 'allow' || mcp.ownTerminals === 'ask') {
      settings.ownTerminals = mcp.ownTerminals
    } else if (mcp.ownTerminals !== undefined) {
      this.addWarning('adt.mcp.ownTerminals', 'must be allow or ask')
    }
    settings.default = this.readMcpRules('adt.mcp.default', mcp.default, settings.default, ['adt', 'mcp', 'default'])
    for (const category of MCP_CATEGORIES) {
      settings[category] = this.readMcpRules(`adt.mcp.${category}`, mcp[category], settings.default, ['adt', 'mcp', category])
    }
    settings.clients = this.readMcpPatterns('adt.mcp.clients', mcp.clients, settings.clients)
    settings.shell = this.readMcpPatterns('adt.mcp.shell', mcp.shell, settings.shell)
    settings.environment = this.readMcpRules('environment.mcp', toRecord(this.initialConfig.environment).mcp, settings.default, ['environment'])
    settings.environmentItems = this.readEnvironmentItems(settings.environment)
    return settings
  }

  /**
   * Reads the `mcp` setting of every item of the environment, an item written as a text being its path.
   * @param inherited The rules of the whole environment.
   * @returns The items with a path, and their rules.
   */
  private readEnvironmentItems (inherited: McpRules): McpEnvironmentItem[] {
    const environment = toRecord(this.initialConfig.environment)
    return Object.entries(ENVIRONMENT_LISTS).flatMap(([list, kind]) =>
      (Array.isArray(environment[list]) ? (environment[list] as unknown[]) : []).flatMap((value, index) => {
        const item = typeof value === 'string' ? { path: value } : toRecord(value)
        if (typeof item.path !== 'string') {
          return []
        }
        const fromPath = ['environment', list, String(index)]
        return [{ path: item.path, kind, rules: this.readMcpRules(`${fromPath.join('.')}.mcp`, item.mcp, inherited, fromPath), target: this.settingTarget([...fromPath, 'mcp']) }]
      })
    )
  }

  /**
   * Reads the `mcp` setting of something of the configuration, warning about what is invalid.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @param inherited The rules of what holds it.
   * @param fromPath The keys leading to what holds the setting in the configuration.
   * @returns The rules.
   */
  private readMcpRules (slug: string, value: unknown, inherited: McpRules, fromPath: string[]): McpRules {
    const { rules, problems } = readMcpRules(value, inherited, fromPath)
    for (const problem of problems) {
      this.addWarning(slug, problem)
    }
    return rules
  }

  /**
   * Applies the `mcp` settings of what holds something over the rules of its category, its problems
   * already reported when the settings were read.
   * @param category The rules of the category of the thing.
   * @param layers The settings of what holds it, the most general first.
   * @returns The rules.
   */
  private layeredRules (category: McpRules, layers: McpLayer[]): McpRules {
    return layers.reduce((rules, layer) => readMcpRules(layer.value, rules, layer.fromPath).rules, category)
  }

  /**
   * Reads a level and the patterns overriding it, `{ level, allow, deny }`.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @param defaults The settings when nothing is declared.
   * @returns The level and patterns.
   */
  private readMcpPatterns (slug: string, value: unknown, defaults: McpPatterns): McpPatterns {
    if (value === undefined) {
      return defaults
    }
    const raw = toRecord(value)
    const patterns: McpPatterns = { ...defaults }
    if (raw.level !== undefined) {
      if (isMcpLevel(raw.level) && raw.level !== 'keys') {
        patterns.level = raw.level
      } else {
        this.addWarning(`${slug}.level`, 'must be allow, ask or deny')
      }
    }
    for (const key of ['allow', 'deny'] as const) {
      if (raw[key] === undefined) {
        continue
      }
      const list = toStringArray(raw[key])
      if (list) {
        patterns[key] = list
      } else {
        this.addWarning(`${slug}.${key}`, 'must be an array of patterns')
      }
    }
    return patterns
  }

  /**
   * Reads the load balancers of the configuration, their certificates and their hosts.
   */
  private reconfigureLoadBalancers (): void {
    const loadBalancers = toRecord(this.initialConfig.loadBalancers)
    for (const [key, value] of Object.entries(loadBalancers)) {
      const options = toRecord(value)
      const domain = key.startsWith('.') ? key : `.${key}`

      if (!this.checkSlug(`loadBalancers[${key}]`, key)) {
        continue
      }

      if (!this.checkString(`loadBalancers[${key}].crt`, options.crt)) {
        continue
      }

      if (!this.checkString(`loadBalancers[${key}].key`, options.key)) {
        continue
      }

      const warn = options.warn ?? 30
      if (!Number.isInteger(warn) || (warn as number) < 1) {
        this.addWarning(`loadBalancers[${key}].warn`, 'must be a positive number of days')
      }

      this.loadBalancers[domain] = {
        crt: options.crt as string,
        key: options.key as string,
        warn: Number.isInteger(warn) && (warn as number) > 0 ? (warn as number) : 30,
        acme: options.acme === undefined ? null : this.readAcme(`loadBalancers[${key}].acme`, domain.slice(1), options),
        mcp: this.readMcpRules(`loadBalancers[${key}].mcp`, options.mcp, this.adt.mcp.certificates, ['loadBalancers', key]),
        mcpTarget: this.settingTarget(['loadBalancers', key, 'mcp'])
      }

      logger.info('Config', 'LoadBalancer', domain)
    }
  }

  /**
   * Reads how a certificate of the load balancer is renewed, `{ trigger, before, env, opAccount, unless,
   * answers, lego | command }`, its automation kept under {@link certificateAutomationKey}.
   * @param slug Names the setting in warnings.
   * @param name The name of the certificate in the configuration.
   * @param certificate The raw certificate, whose `crt` and `key` must be files.
   * @returns The renewal, null when invalid.
   */
  private readAcme (slug: string, name: string, certificate: Record<string, unknown>): CertificateAcme | null {
    const acme = toRecord(certificate.acme)
    if ([certificate.crt, certificate.key].some(file => String(file).trimStart().startsWith('-----BEGIN '))) {
      this.addWarning(slug, 'needs crt and key to be files, not PEM texts')
      return null
    }
    if ((acme.lego === undefined) === (acme.command === undefined)) {
      this.addWarning(slug, 'needs either lego or command')
      return null
    }
    const trigger = acme.trigger ?? 'button'
    if (trigger !== 'button' && trigger !== 'auto' && trigger !== 'both') {
      this.addWarning(`${slug}.trigger`, 'must be button, auto or both')
      return null
    }
    const before = acme.before ?? 30
    if (!Number.isInteger(before) || (before as number) < 1) {
      this.addWarning(`${slug}.before`, 'must be a positive number of days')
      return null
    }

    const lego = acme.lego === undefined ? null : this.readLegoOptions(`${slug}.lego`, acme.lego)
    const command = acme.command === undefined ? null : toCommandArgsArray(acme.command)
    if (acme.command !== undefined && !command?.length) {
      this.addWarning(`${slug}.command`, 'must be a non-empty array of strings or numbers')
      return null
    }
    const env = toStringRecord(acme.env) ?? {}
    const automation = this.readAutomation(slug, acme, command ?? legoRunArgs(lego ?? {}), env)
    if (automation) {
      this.automations[certificateAutomationKey(name)] = automation
    }
    return { trigger, before: before as number, env, lego, command }
  }

  /**
   * Reads the options of `lego run`, the ones the devtool sets itself left out.
   * @param slug Names the setting in warnings.
   * @param value The raw options, by name without their dashes.
   * @returns The valid options.
   */
  private readLegoOptions (slug: string, value: unknown): Record<string, LegoOptionValue> {
    const options: Record<string, LegoOptionValue> = {}
    for (const [name, option] of Object.entries(toRecord(value))) {
      const valid
        = ['string', 'number', 'boolean'].includes(typeof option)
          || (Array.isArray(option) && option.every(item => typeof item === 'string' || typeof item === 'number'))
      if (LEGO_OWNED_OPTIONS.includes(name)) {
        this.addWarning(`${slug}.${name}`, 'is set by the devtool')
      } else if (!valid) {
        this.addWarning(`${slug}.${name}`, 'must be a string, a number, a boolean or a list of strings or numbers')
      } else {
        options[name] = option as LegoOptionValue
      }
    }
    return options
  }

  private async reconfigureProjects (): Promise<void> {
    const projects = toRecord(this.initialConfig.projects)
    for (const [projectSlug, projectRaw] of Object.entries(projects)) {
      const project = toRecord(projectRaw)
      try {
        await this.reconfigureProject(`projects[${projectSlug}]`, projectSlug, project)
      } catch (error) {
        this.addWarning(`projects[${projectSlug}]`, error instanceof Error ? error.message : 'Invalid project')
      }
    }
  }

  /**
   * Reads a section of the sidebar: its folder, settings, directories, integrations and shortcuts.
   * @param slug Names the section in warnings.
   * @param projectSlug The slug of the section.
   * @param project The raw section.
   */
  private async reconfigureProject (slug: string, projectSlug: string, project: Record<string, unknown>): Promise<void> {
    if (!this.checkSlug(slug, projectSlug)) {
      return
    }

    const projectName = this.readOptionalString(`${slug}.name`, project.name, projectSlug)
    if (!this.checkString(`${slug}.path`, project.path)) {
      return
    }
    if (!path.isAbsolute(project.path as string)) {
      this.addWarning(`${slug}.path`, 'is relative to the workspace, which is not declared (workspace: <folder>)')
      return
    }

    const projectPath = this.pathFrom(project.path as string)
    const layers: McpLayer[] = [{ value: project.mcp, fromPath: ['sections', projectSlug] }]
    const projectDefinition: ProjectDefinition = {
      slug: projectSlug,
      name: projectName,
      description: typeof project.description === 'string' ? project.description : null,
      path: projectPath,
      directories: {},
      notifications: project.notifications === false ? false : this.adt.notifications,
      missing: false,
      restore: this.readRestore(`${slug}.restore`, project.restore),
      mcp: this.readMcpRules(`${slug}.mcp`, project.mcp, this.adt.mcp.default, ['sections', projectSlug]),
      mcpTarget: this.settingTarget(['sections', projectSlug, 'mcp']),
      restoreRule: this.layeredRules(this.adt.mcp.commands, layers).run,
      integrations: [],
      icons: [],
      lines: [],
      ...this.readSort(slug, project, this.adt.sidebar.sort),
      content: [],
      meta: project.meta
    }

    const exists = await fs.stat(projectPath).then(stat => stat.isDirectory(), () => false)
    if (!exists && projectDefinition.restore) {
      this.projects[projectSlug] = { ...projectDefinition, missing: true }
      return
    }
    if (!(await this.checkDirectory(`${slug}.path`, projectPath, true))) {
      return
    }

    const directoriesRecord = toRecord(project.directories)
    if (!Object.keys(directoriesRecord).length) {
      this.addWarning(`${slug}.directories`, 'is empty')
      return
    }

    if (project.notifications === true || project.notifications === false) {
      projectDefinition.notifications = project.notifications
    }

    for (const [directorySlug, directoryRaw] of Object.entries(directoriesRecord)) {
      const directory = toRecord(directoryRaw)
      try {
        await this.reconfigureProjectDirectory(`${slug}.directories[${directorySlug}]`, projectDefinition, directorySlug, directory, layers)
      } catch (error) {
        this.addWarning(`${slug}.directories[${directorySlug}]`, error instanceof Error ? error.message : 'Invalid directory')
      }
    }

    if (!Object.keys(projectDefinition.directories).length) {
      this.addWarning(`${slug}.directories`, 'contains no valid entries')
      return
    }

    projectDefinition.integrations = this.readIntegrations(`${slug}.integrations`, project.integrations, { path: projectPath, section: projectSlug, project: null, layers })
    projectDefinition.icons = this.readShortcuts(`${slug}.icons`, projectDefinition, project.icons)
    projectDefinition.lines = this.readShortcuts(`${slug}.lines`, projectDefinition, project.lines)
    projectDefinition.content = this.sortItems(
      `${slug}.order`,
      [
        ...projectDefinition.lines.map(line => ({ key: shortcutKey(line), name: projectDefinition.integrations.find(integration => integration.slug === line.slug)?.name ?? line.slug })),
        ...Object.values(projectDefinition.directories).map(directory => ({ key: directory.slug, name: directory.name }))
      ],
      projectDefinition
    )
    this.projects[projectSlug] = projectDefinition
  }

  /**
   * Reads how a list of the sidebar is ordered, `sort` and `order`.
   * @param slug Names the setting holding them in warnings.
   * @param setting The raw setting holding them.
   * @param fallback The mode when none or an invalid one is given.
   * @returns The mode and the keys in the order chosen by hand.
   */
  private readSort (slug: string, setting: Record<string, unknown>, fallback: SortMode): { sort: SortMode, order: string[] } {
    let sort = setting.sort ?? fallback
    if (!SORT_MODES.includes(sort as SortMode)) {
      this.addWarning(`${slug}.sort`, `must be ${SORT_MODES.join(', ')}`)
      sort = fallback
    }
    const order = setting.order === undefined ? [] : toStringArray(setting.order)
    if (!order) {
      this.addWarning(`${slug}.order`, 'must be a list')
    }
    return { sort: sort as SortMode, order: order ?? [] }
  }

  /**
   * Orders items of the sidebar, warning about the keys of `order` naming none of them.
   * @param slug Names the `order` setting in warnings.
   * @param items The items, in the order of the configuration, each with its key and the name shown.
   * @param ordering How they are ordered.
   * @returns The keys of the items in order.
   */
  private sortItems (slug: string, items: { key: string, name: string }[], ordering: { sort: SortMode, order: string[] }): string[] {
    for (const key of ordering.order.filter(entry => !items.some(item => item.key === entry))) {
      this.addWarning(slug, `${key} names nothing here`)
    }
    return sortKeys(items, ordering.sort, ordering.order)
  }

  /**
   * Reads a directory of a project: its commands, which inherit its environment, services, scripts, files
   * and integrations, its main command being the command its default action names, else its own `args`.
   * @param slug Names the directory in warnings.
   * @param projectDefinition The project receiving the directory.
   * @param directorySlug The slug of the directory.
   * @param directory The raw directory.
   * @param sectionLayers The `mcp` settings of its project, applied over the rules of each category.
   */
  private async reconfigureProjectDirectory (
    slug: string,
    projectDefinition: ProjectDefinition,
    directorySlug: string,
    directory: Record<string, unknown>,
    sectionLayers: McpLayer[]
  ): Promise<void> {
    const layers: McpLayer[] = [...sectionLayers, { value: directory.mcp, fromPath: ['projects', directorySlug] }]
    if (!this.checkSlug(slug, directorySlug)) {
      return
    }
    if (typeof directory.section === 'string' && directory.section !== projectDefinition.slug) {
      this.addWarning(`${slug}.section`, `names no section, the project is under ${projectDefinition.slug}`)
    }

    const directoryName = this.readOptionalString(`${slug}.name`, directory.name, directorySlug)
    const relativePath = this.readOptionalString(`${slug}.path`, directory.path, directorySlug)
    const directoryPath = this.pathFrom(projectDefinition.path, relativePath)

    const action = toRecord(directory.default).action
    const mainCommand = typeof action === 'string' && action.startsWith('command:') ? action.slice('command:'.length) : null
    const args = mainCommand || directory.args === undefined || directory.args === null ? null : this.readCommandArgs(`${slug}.args`, directory.args)
    if (!mainCommand && directory.args !== undefined && directory.args !== null && !args) {
      return
    }

    const directoryDefinition: DirectoryDefinition = {
      slug: directorySlug,
      name: directoryName,
      description: typeof directory.description === 'string' ? directory.description : null,
      path: directoryPath,
      loadBalancer: {},
      args,
      extras: {},
      scripts: [],
      files: {},
      defaultAction: null,
      integrations: [],
      icons: [],
      lines: [],
      notifications: directory.notifications === false ? false : projectDefinition.notifications,
      env: {},
      shell: this.adt.shell,
      killSignal: null,
      missing: false,
      restore: this.readRestore(`${slug}.restore`, directory.restore),
      mcp: this.readMcpRules(`${slug}.mcp`, directory.mcp, projectDefinition.mcp, ['projects', directorySlug]),
      mcpTarget: this.settingTarget(['projects', directorySlug, 'mcp']),
      restoreRule: this.layeredRules(this.adt.mcp.commands, layers).run,
      meta: directory.meta
    }

    const exists = await fs.stat(directoryPath).then(stat => stat.isDirectory(), () => false)
    if (!exists && directoryDefinition.restore) {
      projectDefinition.directories[directorySlug] = { ...directoryDefinition, missing: true }
      return
    }
    if (!(await this.checkDirectory(`${slug}.path`, directoryPath))) {
      return
    }

    if (directory.notifications === true || directory.notifications === false) {
      directoryDefinition.notifications = directory.notifications
    }

    const env = toStringRecord(directory.env)
    if (env) {
      directoryDefinition.env = env
    }

    const directoryShell = this.readShell(
      `${slug}.shell`,
      directory.shell
    )
    if (directoryShell !== null) {
      directoryDefinition.shell = directoryShell
    }

    const directoryKillSignal = this.readKillSignal(
      `${slug}.killSignal`,
      directory.killSignal ?? directory.killsignal
    )
    if (directoryKillSignal !== null) {
      directoryDefinition.killSignal = directoryKillSignal
    }

    const lbRecord = toRecord(directory.loadBalancer)
    for (const [lbSlug, lbRaw] of Object.entries(lbRecord)) {
      const lb = toRecord(lbRaw)
      const setting = `${slug}.services[${lbSlug}]`
      for (const replaced of ['ports', 'urls', 'url'].filter(key => key in lb)) {
        this.addWarning(`${setting}.${replaced}`, 'is replaced by target: <port> | <host>:<port> | <URL>, or a list of them')
      }

      const rawHosts = lb.hosts ?? lb.host
      const hosts = typeof rawHosts === 'string' ? [rawHosts] : toStringArray(rawHosts)
      if (!hosts?.length) {
        this.addWarning(`${setting}.host`, 'must be a host name or a list of host names')
        continue
      }
      const targets = this.readTargets(`${setting}.target`, lb.target)
      if (!targets) {
        continue
      }

      const tls = lb.tls === true
      if ('tls' in lb && lb.tls !== true && lb.tls !== false) {
        this.addWarning(`${setting}.tls`, 'is not a boolean')
        continue
      }

      if (lb.path && !this.checkString(`${setting}.path`, lb.path)) {
        continue
      }
      if (lb.prefix && !this.checkString(`${setting}.prefix`, lb.prefix)) {
        continue
      }
      if (lb.pathNot && !this.checkString(`${setting}.pathNot`, lb.pathNot)) {
        continue
      }

      const preserveHost = lb.preserveHost === true
      if ('preserveHost' in lb && lb.preserveHost !== true && lb.preserveHost !== false) {
        this.addWarning(`${setting}.preserveHost`, 'is not a boolean')
        continue
      }

      directoryDefinition.loadBalancer[lbSlug] = {
        slug: lbSlug,
        hosts,
        targets,
        tls,
        path: typeof lb.path === 'string' ? lb.path : null,
        prefix: typeof lb.prefix === 'string' ? lb.prefix : null,
        pathNot: typeof lb.pathNot === 'string' ? lb.pathNot : null,
        preserveHost,
        access: this.readAccess(`${setting}.access`, lb.access)
      }
    }

    const extras = toRecord(directory.extras)
    for (const [extraSlug, extraRaw] of Object.entries(extras)) {
      if (extraSlug === 'default') {
        this.addWarning(`${slug}.commands.default`, 'is replaced by default: { action: command:<slug> }')
        continue
      }
      const extra = toRecord(extraRaw)
      const extraArgs = this.readCommandArgs(`${slug}.extras[${extraSlug}].args`, extra.args)
      if (!extraArgs) {
        continue
      }

      const extraName = this.readOptionalString(`${slug}.extras[${extraSlug}].name`, extra.name, extraSlug)
      const extraEnv = { ...directoryDefinition.env, ...toStringRecord(extra.env) }
      const automation = this.readAutomation(`${slug}.extras[${extraSlug}]`, extra, extraArgs, extraEnv)
      if (automation) {
        this.automations[`${projectDefinition.slug}/${directorySlug}/${extraSlug}`] = automation
      }

      directoryDefinition.extras[extraSlug] = {
        slug: extraSlug,
        name: extraName,
        args: extraArgs,
        detached: extra.detached === true,
        prompt: extra.prompt === true,
        form: this.readForm(`${slug}.extras[${extraSlug}].form`, extra.form) ?? 'dialog',
        automated: automation !== null,
        startWithSection: extra.startWithSection === true,
        notifications: extra.notifications === false ? false : directoryDefinition.notifications,
        env: extraEnv,
        shell: this.readShell(
          `${slug}.extras[${extraSlug}].shell`,
          extra.shell
        ) ?? directoryDefinition.shell,
        killSignal: this.readKillSignal(
          `${slug}.extras[${extraSlug}].killSignal`,
          extra.killSignal ?? extra.killsignal
        ),
        script: null,
        mcp: this.readMcpRules(`${slug}.extras[${extraSlug}].mcp`, extra.mcp, this.layeredRules(this.adt.mcp.commands, layers), ['projects', directorySlug, 'commands', extraSlug]),
        mcpTarget: this.settingTarget(['projects', directorySlug, 'commands', extraSlug, 'mcp']),
        meta: extra.meta
      }
    }

    directoryDefinition.scripts = await this.readScripts(`${slug}.scripts`, directoryPath, directory.scripts, this.layeredRules(this.adt.mcp.scripts, layers), ['projects', directorySlug, 'scripts'])
    const scripts = await listScripts(directoryDefinition).catch((error: unknown) => {
      this.addWarning(`${slug}.scripts`, error instanceof Error ? error.message : String(error))
      return []
    })
    for (const script of scripts) {
      if (script.slug in directoryDefinition.extras) {
        this.addWarning(`${slug}.scripts`, `${script.slug} is hidden by the command of the same slug`)
        continue
      }
      directoryDefinition.extras[script.slug] = script
    }
    if (mainCommand) {
      directoryDefinition.args = directoryDefinition.extras[mainCommand]?.args ?? null
    }
    directoryDefinition.files = this.readFiles(`${slug}.files`, directoryDefinition, directory.files, this.layeredRules(this.adt.mcp.files, layers))
    directoryDefinition.integrations = this.readIntegrations(`${slug}.integrations`, directory.integrations, { path: directoryPath, section: projectDefinition.slug, project: directorySlug, layers })
    directoryDefinition.defaultAction = this.readDefaultAction(`${slug}.default`, directoryDefinition, directory.default)
    directoryDefinition.icons = this.readShortcuts(`${slug}.icons`, directoryDefinition, directory.icons)
    directoryDefinition.lines = this.readShortcuts(`${slug}.lines`, directoryDefinition, directory.lines)

    projectDefinition.directories[directorySlug] = directoryDefinition
  }

  /**
   * Reads the command bringing back the folder of a project when it is missing, `{ name, args }`.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @returns The command, null when none is declared or it is invalid.
   */
  private readRestore (slug: string, value: unknown): ProjectRestore | null {
    if (value === undefined) {
      return null
    }

    const restore = toRecord(value)
    const args = toCommandArgsArray(restore.args)
    if (!args?.length) {
      this.addWarning(`${slug}.args`, 'must be a non-empty array of strings or numbers')
      return null
    }
    return { name: typeof restore.name === 'string' ? restore.name : 'Restore', args }
  }

  /**
   * Reads who reaches a host through the load balancer.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @returns `network` when declared, `local` otherwise.
   */
  private readAccess (slug: string, value: unknown): HostAccess {
    if (value === undefined || value === 'local' || value === 'network') {
      return value ?? 'local'
    }

    this.addWarning(slug, 'must be local or network, local is used')
    return 'local'
  }

  /**
   * Reads the hosts whose TLS connections the load balancer forwards untouched, each
   * `{ hosts, target: <host>:<port>, access }`.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @returns The valid rules.
   */
  private readPassthrough (slug: string, value: unknown): PassthroughRule[] {
    if (value === undefined) {
      return []
    }
    if (!Array.isArray(value)) {
      this.addWarning(slug, 'must be an array')
      return []
    }

    const rules: PassthroughRule[] = []
    for (const [index, raw] of value.entries()) {
      const rule = toRecord(raw)
      const hosts = toStringArray(rule.hosts)?.map(host => host.toLowerCase())
      const target = typeof rule.target === 'string' ? /^(.+):(\d+)$/.exec(rule.target) : null
      if (!hosts?.length || hosts.some(host => !HOST_PATTERN_REGEXP.test(host))) {
        this.addWarning(`${slug}[${index}].hosts`, 'must be host names or *.<domain>')
        continue
      }
      const port = Number(target?.[2])
      if (!target || port < 1 || port > 65535) {
        this.addWarning(`${slug}[${index}].target`, 'must be <host>:<port>, the port between 1 and 65535')
        continue
      }

      rules.push({ hosts, host: target[1], port, access: this.readAccess(`${slug}[${index}].access`, rule.access) })
    }
    return rules
  }

  /**
   * Reads the local DNS: `{ enabled, port, access, upstream, records: { <slug>: { names, address } } }`,
   * the records being a map so personal configuration files add their own.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @returns The DNS, null when it is disabled or declares no valid record.
   */
  private readDns (slug: string, value: unknown): DnsDefinition | null {
    if (value === undefined) {
      return null
    }

    const dns = toRecord(value)
    if (dns.enabled !== undefined && typeof dns.enabled !== 'boolean') {
      this.addWarning(`${slug}.enabled`, 'must be true or false')
    }
    if (dns.enabled === false) {
      return null
    }
    const records: DnsRecord[] = []
    for (const [recordSlug, raw] of Object.entries(toRecord(dns.records))) {
      const record = toRecord(raw)
      const names = toStringArray(record.names)?.map(name => name.toLowerCase())
      if (!names?.length || names.some(name => !HOST_PATTERN_REGEXP.test(name))) {
        this.addWarning(`${slug}.records[${recordSlug}].names`, 'must be host names or *.<domain>')
        continue
      }
      if (typeof record.address !== 'string' || (record.address !== 'auto' && !net.isIPv4(record.address))) {
        this.addWarning(`${slug}.records[${recordSlug}].address`, 'must be an IPv4 address or auto')
        continue
      }
      records.push({ names, address: record.address })
    }

    const port = dns.port === undefined ? 53 : Number(dns.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      this.addWarning(`${slug}.port`, 'must be a port number')
      return null
    }
    return records.length ? { port, access: this.readAccess(`${slug}.access`, dns.access), records, upstream: this.readDnsUpstream(`${slug}.upstream`, dns.upstream, port) } : null
  }

  /**
   * Reads the server the local DNS relays the other names to, `<host>[:<port>]` (`[<IPv6>]:<port>`),
   * port 53 by default.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @param ownPort The port of the local DNS, which must not relay to itself.
   * @returns The server, null when the setting is missing or invalid.
   */
  private readDnsUpstream (slug: string, value: unknown, ownPort: number): DnsServerAddress | null {
    if (value === undefined) {
      return null
    }

    const match = typeof value === 'string' ? DNS_SERVER_REGEXP.exec(value.trim()) : null
    const host = match?.[1] ?? match?.[2]
    const port = match?.[3] === undefined ? 53 : Number(match[3])
    if (!host || (match?.[1] !== undefined && !net.isIPv6(host)) || port < 1 || port > 65535) {
      this.addWarning(slug, 'must be <host>[:<port>], such as 127.0.0.1:5353')
      return null
    }
    if (port === ownPort && (host === 'localhost' || host === '::1' || host.startsWith('127.'))) {
      this.addWarning(slug, 'is this DNS itself: give the address of another DNS server')
      return null
    }
    return { host, port }
  }

  /**
   * Reads the integrations, `{ <slug>: { name, type, url, icon, embed } }`, in the order they are
   * declared; those listing pull requests or issues are read by {@link readForgeIntegration}, their
   * token kept in {@link integrationTokens}.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @param owner The section or the project declaring them, null at the root.
   * @returns The valid integrations.
   */
  private readIntegrations (slug: string, value: unknown, owner: IntegrationOwner | null): IntegrationDefinition[] {
    if (value === undefined) {
      return []
    }
    if (!isObject(value)) {
      this.addWarning(slug, 'must be a map of integrations')
      return []
    }

    const integrations: IntegrationDefinition[] = []
    for (const [integrationSlug, raw] of Object.entries(value)) {
      const integration = toRecord(raw)
      const setting = `${slug}.${integrationSlug}`
      if (!this.checkSlug(setting, integrationSlug) || !this.checkString(`${setting}.name`, integration.name)) {
        continue
      }
      const type = (integration.type ?? 'web') as IntegrationType
      if (!INTEGRATION_TYPES.includes(type)) {
        this.addWarning(`${setting}.type`, `must be ${INTEGRATION_TYPES.join(' or ')}`)
        continue
      }
      if (integration.icon !== undefined && !this.checkString(`${setting}.icon`, integration.icon)) {
        continue
      }
      if (type !== 'web') {
        const forgeIntegration = owner ? this.readForgeIntegration(setting, integrationSlug, type, integration, owner) : null
        if (!owner) {
          this.addWarning(`${setting}.type`, `${type} needs a section or a project, whose folder the agents work in`)
        }
        if (forgeIntegration) {
          integrations.push(forgeIntegration)
        }
        continue
      }
      if (typeof integration.url !== 'string' || !/^https?:\/\/[^/]/.test(integration.url)) {
        this.addWarning(`${setting}.url`, 'must be an http or https URL')
        continue
      }
      if (integration.embed !== undefined && typeof integration.embed !== 'boolean') {
        this.addWarning(`${setting}.embed`, 'must be true or false')
        continue
      }

      integrations.push({
        slug: integrationSlug,
        name: integration.name as string,
        type: 'web',
        icon: (integration.icon as string | undefined) ?? DEFAULT_INTEGRATION_ICON,
        url: integration.url,
        embed: integration.embed ?? true,
        provider: null,
        agentActions: [],
        agentPrompts: {},
        badge: false,
        refresh: 0,
        mcp: null,
        mcpTarget: null
      })
    }
    return integrations
  }

  /**
   * Reads an integration listing the pull requests or the issues of a repository: `url`, the `origin`
   * remote of the folder of its owner by default, `provider`, guessed from the host by default, `token`,
   * read with value blocks, `opAccount`, `refresh` in minutes, `badge`, the actions of agents its kind
   * offers (`agentReview`, `agentAnalyze`, `agentFix`), each off by default, their `agentPrompts`,
   * over those of `adt.agentPrompts` and of the devtool, and `mcp`, what agents may do with its items,
   * over `adt.mcp.integrations` and the rules of its section and project.
   * @param setting Names the integration in warnings.
   * @param slug The slug of the integration.
   * @param kind What it lists.
   * @param integration The raw integration.
   * @param owner The section or the project declaring it.
   * @returns The integration, null when invalid.
   */
  private readForgeIntegration (setting: string, slug: string, kind: ForgeKind, integration: Record<string, unknown>, owner: IntegrationOwner): IntegrationDefinition | null {
    const url = integration.url ?? originUrl(owner.path)
    const repository = typeof url === 'string' ? repositoryOf(url) : null
    if (!repository) {
      this.addWarning(`${setting}.url`, integration.url === undefined ? `is missing and ${owner.path} has no origin remote` : 'must name a repository')
      return null
    }
    const names = FORGES.map(known => known.name).join(', ')
    const forge = integration.provider === undefined || typeof integration.provider === 'string' ? findForge((integration.provider) ?? null, repository) : null
    if (!forge) {
      this.addWarning(`${setting}.provider`, integration.provider === undefined ? `cannot be guessed from ${repository.host}, set one of ${names}` : `must be one of ${names}`)
      return null
    }
    const refresh = integration.refresh ?? 5
    if (typeof refresh !== 'number' || refresh < 0) {
      this.addWarning(`${setting}.refresh`, 'must be a number of minutes, 0 to read on demand only')
      return null
    }
    for (const flag of ['badge', ...Object.values(AGENT_ACTION_SETTINGS)]) {
      if (integration[flag] !== undefined && typeof integration[flag] !== 'boolean') {
        this.addWarning(`${setting}.${flag}`, 'must be true or false')
        return null
      }
    }
    for (const [action, flag] of Object.entries(AGENT_ACTION_SETTINGS) as [AgentAction, string][]) {
      if (integration[flag] !== undefined && !AGENT_ACTIONS[kind].includes(action)) {
        this.addWarning(`${setting}.${flag}`, `is not an action of ${kind}, which offer ${AGENT_ACTIONS[kind].map(item => AGENT_ACTION_SETTINGS[item]).join(', ')}`)
      }
    }
    if (integration.token !== undefined && !this.checkString(`${setting}.token`, integration.token)) {
      return null
    }
    const prompts = this.readAgentPrompts(`${setting}.agentPrompts`, kind, integration.agentPrompts)
    const fromPath = owner.project === null ? ['sections', owner.section, 'integrations', slug] : ['projects', owner.project, 'integrations', slug]

    const key = integrationKey(owner.section, owner.project, slug)
    if (typeof integration.token === 'string') {
      this.integrationTokens[key] = integration.token
      const automation = this.readAutomation(setting, integration, [], { token: integration.token })
      if (automation) {
        this.automations[integrationAutomationKey(key)] = automation
      }
    }
    return {
      slug,
      name: integration.name as string,
      type: kind,
      icon: (integration.icon as string | undefined) ?? DEFAULT_FORGE_ICONS[kind],
      url: repository.webUrl,
      embed: false,
      provider: { name: forge.name, label: forge.label },
      agentActions: AGENT_ACTIONS[kind].filter(action => integration[AGENT_ACTION_SETTINGS[action]] === true),
      agentPrompts: Object.fromEntries(AGENT_ACTIONS[kind].map(action => [action, prompts[action] ?? this.agentPrompts[kind]?.[action] ?? DEFAULT_AGENT_PROMPTS[action]])),
      badge: (integration.badge as boolean | undefined) ?? true,
      refresh,
      mcp: this.readMcpRules(`${setting}.mcp`, integration.mcp, this.layeredRules(this.adt.mcp.integrations, owner.layers), fromPath),
      mcpTarget: this.settingTarget([...fromPath, 'mcp'])
    }
  }

  /**
   * Reads prompts of the actions of agents, `{ <action>: <prompt> }`, keeping those of the actions of a kind.
   * @param slug Names the setting in warnings.
   * @param kind The kind of the items the actions are about.
   * @param value The raw setting.
   * @returns The prompts, by action.
   */
  private readAgentPrompts (slug: string, kind: ForgeKind, value: unknown): Partial<Record<AgentAction, string>> {
    if (value === undefined) {
      return {}
    }
    if (!isObject(value)) {
      this.addWarning(slug, 'must be a map of prompts by action')
      return {}
    }
    const prompts: Partial<Record<AgentAction, string>> = {}
    for (const [action, prompt] of Object.entries(value)) {
      if (!AGENT_ACTIONS[kind].includes(action as AgentAction)) {
        this.addWarning(`${slug}.${action}`, `is not an action of ${kind}, which offer ${AGENT_ACTIONS[kind].join(', ')}`)
      } else if (this.checkString(`${slug}.${action}`, prompt)) {
        prompts[action as AgentAction] = prompt as string
      }
    }
    return prompts
  }

  /**
   * Reads the AI agents the interface starts, `adt.agents`: `{ <slug>: { name, icon, args | url, env,
   * opAccount } }`, their automations kept under {@link agentAutomationKey}.
   * @param value The raw setting.
   * @returns The valid agents, in the order they are declared.
   */
  private readAgents (value: unknown): AgentDefinition[] {
    if (value === undefined) {
      return []
    }
    if (!isObject(value)) {
      this.addWarning('adt.agents', 'must be a map of agents')
      return []
    }

    const agents: AgentDefinition[] = []
    for (const [agentSlug, raw] of Object.entries(value)) {
      const agent = toRecord(raw)
      const setting = `adt.agents.${agentSlug}`
      if (!this.checkSlug(setting, agentSlug) || !this.checkString(`${setting}.name`, agent.name)) {
        continue
      }
      if (agent.icon !== undefined && !this.checkString(`${setting}.icon`, agent.icon)) {
        continue
      }
      if ((agent.args === undefined) === (agent.url === undefined)) {
        this.addWarning(setting, 'needs either args, run in a terminal, or url, opened by the interface')
        continue
      }
      const args = agent.args === undefined ? null : toCommandArgsArray(agent.args)
      if (agent.args !== undefined && !args?.length) {
        this.addWarning(`${setting}.args`, 'must be a non-empty array of strings or numbers')
        continue
      }
      if (agent.url !== undefined && !this.checkString(`${setting}.url`, agent.url)) {
        continue
      }
      const env = toStringRecord(agent.env) ?? {}
      const automation = this.readAutomation(setting, agent, args ?? [], env)
      if (automation) {
        this.automations[agentAutomationKey(agentSlug)] = automation
      }
      agents.push({
        slug: agentSlug,
        name: agent.name as string,
        icon: (agent.icon as string | undefined) ?? DEFAULT_AGENT_ICON,
        args,
        url: (agent.url as string | undefined) ?? null,
        env
      })
    }
    return agents
  }

  /**
   * Reads a list of shortcuts, each `integration:<slug>`, `command:<slug>`, `files:<slug>` or
   * `service:<slug>[:<host index>]`, keeping those naming something of their owner.
   * @param slug Names the setting in warnings.
   * @param owner The directory, or the project offering its integrations only, all already read.
   * @param value The raw setting.
   * @returns The valid shortcuts, in order.
   */
  private readShortcuts (slug: string, owner: ShortcutOwner, value: unknown): DirectoryShortcut[] {
    if (value === undefined) {
      return []
    }
    if (!Array.isArray(value)) {
      this.addWarning(slug, 'must be a list of <type>:<slug>')
      return []
    }
    return value.flatMap((entry, index) => this.readShortcut(`${slug}[${index}]`, owner, entry) ?? [])
  }

  /**
   * Reads one shortcut, `integration:<slug>`, `command:<slug>`, `files:<slug>` or
   * `service:<slug>[:<host index>]`.
   * @param slug Names the setting in warnings.
   * @param owner The directory, or the project offering its integrations only, all already read.
   * @param value The raw shortcut.
   * @returns The shortcut, null when it names nothing of its owner.
   */
  private readShortcut (slug: string, owner: ShortcutOwner, value: unknown): DirectoryShortcut | null {
    if (typeof value !== 'string') {
      this.addWarning(slug, 'must be <type>:<slug>')
      return null
    }

    const [type, target = '', hostIndex = '0'] = value.split(':')
    const shortcut = { type, slug: target, index: Number(hostIndex) } as DirectoryShortcut
    const exists
      = (type === 'integration' && owner.integrations.some(integration => integration.slug === target))
        || (type === 'command' && owner.extras !== undefined && target in owner.extras)
        || (type === 'files' && owner.files !== undefined && target in owner.files)
        || (type === 'service' && Number.isInteger(shortcut.index) && owner.loadBalancer?.[target]?.hosts[shortcut.index] !== undefined)
    if (!exists) {
      this.addWarning(slug, owner.extras === undefined ? `${value} names no integration of the section` : `${value} names no integration, command, files or service host of the directory`)
      return null
    }
    return shortcut
  }

  /**
   * Reads what the server does on its own around a command: `unless`, a command whose success skips
   * it, `answers`, `{ match, value }` typed when the output asks `match`, and the value blocks of its
   * arguments, environment and answers, `{{ op://… }}` read from `opAccount`, `{{ file://… }}` or `{{ $(…) }}`.
   * @param slug Names the command in warnings.
   * @param command The raw command.
   * @param args The arguments of the command, whose inputs hold no value block.
   * @param env The environment of the command.
   * @returns The automation, null when the command declares none.
   */
  private readAutomation (slug: string, command: Record<string, unknown>, args: CommandArg[], env: Record<string, string>): CommandAutomation | null {
    const values = [
      ...args.flatMap((arg, index) => (typeof arg === 'string' ? [{ slug: `${slug}.args[${index}]`, text: arg }] : [])),
      ...Object.entries(env).map(([key, value]) => ({ slug: `${slug}.env.${key}`, text: value })),
      ...(Array.isArray(command.answers) ? command.answers : []).map((raw, index) => ({ slug: `${slug}.answers[${index}].value`, text: typeof toRecord(raw).value === 'string' ? toRecord(raw).value as string : '' }))
    ]
    for (const value of values) {
      for (const block of findInvalidValueBlocks(value.text)) {
        this.addWarning(value.slug, `unknown value block ${block}, expected {{ op://… }}, {{ file://… }}, {{ $(…) }} or {{ auth://… }}`)
      }
    }

    const hasBlocks = values.some(value => value.text.includes('{{'))
    if (!hasBlocks && command.unless === undefined && command.answers === undefined && command.opAccount === undefined) {
      return null
    }

    const unless = command.unless === undefined ? null : toCommandArgsArray(command.unless)
    if (command.unless !== undefined && !unless) {
      this.addWarning(`${slug}.unless`, 'must be an array of strings or numbers')
    }

    const answers: CommandAnswer[] = []
    for (const [index, raw] of (Array.isArray(command.answers) ? command.answers : []).entries()) {
      const answer = toRecord(raw)
      if (typeof answer.match !== 'string' || typeof answer.value !== 'string') {
        this.addWarning(`${slug}.answers[${index}]`, 'must be { match, value }')
        continue
      }
      try {
        answers.push({ pattern: new RegExp(answer.match, 'i'), value: answer.value })
      } catch {
        this.addWarning(`${slug}.answers[${index}].match`, 'is not a valid regular expression')
      }
    }

    return { unless, opAccount: typeof command.opAccount === 'string' ? command.opAccount : null, answers }
  }

  /**
   * Reads the folders whose executables a directory offers as scripts, each given as its path or as
   * `{ path, prompt, form, only, mcp, scripts }`.
   * @param slug Names the setting in warnings.
   * @param directoryPath Absolute path of the directory, relative folders are resolved from it.
   * @param value The raw setting.
   * @param inherited The MCP rules of the directory.
   * @param settingPath The keys leading to the setting in the configuration files.
   * @returns The existing folders.
   */
  private async readScripts (slug: string, directoryPath: string, value: unknown, inherited: McpRules, settingPath: string[]): Promise<DirectoryScripts[]> {
    if (value === undefined) {
      return []
    }
    if (!Array.isArray(value)) {
      this.addWarning(slug, 'must be an array')
      return []
    }

    const folders: DirectoryScripts[] = []
    for (const [index, raw] of value.entries()) {
      const folder = typeof raw === 'string' ? { path: raw } : toRecord(raw)
      if (!this.checkString(`${slug}[${index}].path`, folder.path)) {
        continue
      }

      const folderPath = this.pathFrom(directoryPath, folder.path as string)
      if (!(await this.checkDirectory(`${slug}[${index}]`, folderPath))) {
        continue
      }

      const folderSetting = [...settingPath, String(index)]
      const mcp = this.readMcpRules(`${slug}[${index}].mcp`, folder.mcp, inherited, folderSetting)
      const scripts: Record<string, ScriptSettings> = {}
      for (const [name, settingsRaw] of Object.entries(toRecord(folder.scripts))) {
        const settings = toRecord(settingsRaw)
        scripts[name] = {
          prompt: typeof settings.prompt === 'boolean' ? settings.prompt : null,
          args: settings.args === undefined ? null : this.readCommandArgs(`${slug}[${index}].scripts[${name}].args`, settings.args),
          form: this.readForm(`${slug}[${index}].scripts[${name}].form`, settings.form),
          mcp: this.readMcpRules(`${slug}[${index}].scripts[${name}].mcp`, settings.mcp, mcp, [...folderSetting, 'scripts', name]),
          mcpTarget: this.settingTarget([...folderSetting, 'scripts', name, 'mcp'])
        }
      }
      const only = folder.only === undefined ? null : toStringArray(folder.only)
      if (folder.only !== undefined && !only) {
        this.addWarning(`${slug}[${index}].only`, 'must be an array of glob patterns')
      }
      folders.push({ path: folderPath, prompt: folder.prompt === true, form: this.readForm(`${slug}[${index}].form`, folder.form) ?? 'inline', only, scripts, mcp, mcpTarget: this.settingTarget([...folderSetting, 'mcp']) })
    }
    return folders
  }

  /**
   * Reads where the page of a directory asks for the inputs of a command, `dialog`, `inline` or `inlineExpanded`.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @returns The form, null when the setting is missing or invalid.
   */
  private readForm (slug: string, value: unknown): CommandForm | null {
    if (value === 'dialog' || value === 'inline' || value === 'inlineExpanded') {
      return value
    }
    if (value !== undefined) {
      this.addWarning(slug, 'must be dialog, inline or inlineExpanded')
    }
    return null
  }

  /**
   * Reads the arguments of a command: strings, numbers and inputs typed when it starts, each
   * `{ name, choices, optional, display: buttons | dropdown }`, `{ name, flag: true }` or
   * `{ name, text: true }`; invalid entries are left out.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @returns The arguments, in order, null when the setting is not a list.
   */
  private readCommandArgs (slug: string, value: unknown): CommandArg[] | null {
    if (!Array.isArray(value)) {
      this.addWarning(slug, 'must be an array of strings, numbers or inputs')
      return null
    }

    const args: CommandArg[] = []
    for (const [index, raw] of value.entries()) {
      if (typeof raw === 'string' || (typeof raw === 'number' && Number.isFinite(raw))) {
        args.push(String(raw))
        continue
      }

      const input = this.readCommandInput(`${slug}[${index}]`, raw)
      if (input) {
        args.push(input)
      }
    }
    return args
  }

  /**
   * Reads the choices of an input, each a value or `{ label, value }`; invalid ones are left out.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @returns The choices, null when the setting is not a list.
   */
  private readChoices (slug: string, value: unknown): CommandChoice[] | null {
    if (!Array.isArray(value)) {
      return null
    }

    return value.flatMap((raw, index) => {
      const choice = typeof raw === 'string' || typeof raw === 'number' ? { value: raw } : toRecord(raw)
      if (typeof choice.value !== 'string' && typeof choice.value !== 'number') {
        this.addWarning(`${slug}[${index}]`, 'must be a value or { label, value }')
        return []
      }
      const choiceValue = String(choice.value)
      return [{ label: typeof choice.label === 'string' ? choice.label : choiceValue, value: choiceValue }]
    })
  }

  /**
   * Reads an input of a command, `{ name, choices, optional, display, default }`, `{ name, flag: true, default }`
   * or `{ name, text: true, default }`.
   * @param slug Names the input in warnings.
   * @param value The raw input.
   * @returns The input, null when invalid.
   */
  private readCommandInput (slug: string, value: unknown): CommandInput | null {
    const input = toRecord(value)
    if (!this.checkString(`${slug}.name`, input.name)) {
      return null
    }

    const name = input.name as string
    const choices = this.readChoices(`${slug}.choices`, input.choices)
    let parsed: CommandInput
    if (choices?.length) {
      if (input.display !== undefined && input.display !== 'buttons' && input.display !== 'dropdown') {
        this.addWarning(`${slug}.display`, 'must be buttons or dropdown')
      }
      parsed = { name, kind: 'choice', choices, display: input.display === 'dropdown' ? 'dropdown' : 'buttons', optional: input.optional === true, default: null }
    } else if (input.flag === true || input.text === true) {
      parsed = { name, kind: input.flag === true ? 'flag' : 'text', choices: [], display: 'buttons', optional: true, default: null }
    } else {
      this.addWarning(slug, 'must be a string, a number, or an input with choices, flag: true or text: true')
      return null
    }

    const fallback = typeof input.default === 'number' ? String(input.default) : input.default
    const valid
      = (parsed.kind === 'choice' && typeof fallback === 'string' && parsed.choices.some(choice => choice.value === fallback))
        || (parsed.kind === 'flag' && typeof fallback === 'boolean')
        || (parsed.kind === 'text' && typeof fallback === 'string')
    if (fallback !== undefined && fallback !== null && !valid) {
      this.addWarning(`${slug}.default`, parsed.kind === 'choice' ? 'must be one of the choices' : parsed.kind === 'flag' ? 'must be a boolean' : 'must be a string')
    }
    return { ...parsed, default: valid ? (fallback) : null }
  }

  /**
   * Reads what a directory does by default, `{ action: <type>:<slug>, trigger: icon | row | row-icon, icon: own | <prefix>:<name> }`.
   * @param slug Names the setting in warnings.
   * @param directory The directory, its integrations, commands, files and services already read.
   * @param value The raw setting.
   * @returns The default action, null when there is none.
   */
  private readDefaultAction (slug: string, directory: DirectoryDefinition, value: unknown): DirectoryDefaultAction | null {
    if (value === undefined) {
      return null
    }

    const setting = toRecord(value)
    const shortcut = this.readShortcut(`${slug}.action`, directory, setting.action)
    if (setting.trigger !== undefined && setting.trigger !== 'icon' && setting.trigger !== 'row' && setting.trigger !== 'row-icon') {
      this.addWarning(`${slug}.trigger`, 'must be icon, row or row-icon')
      return null
    }
    if (setting.icon !== undefined && (typeof setting.icon !== 'string' || (setting.icon !== 'own' && !setting.icon.includes(':')))) {
      this.addWarning(`${slug}.icon`, 'must be own or an Iconify name <prefix>:<name>')
      return null
    }
    return shortcut ? { shortcut, trigger: setting.trigger ?? 'icon', icon: setting.icon ?? null } : null
  }

  /**
   * Reads where a service sends its requests: a port of this machine, `<host>:<port>` or an http(s)
   * URL, or a list of them shared in turn. A port, given as a number or as decimal digits, lies
   * between 1 and 65535.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @returns The targets as URLs, null when one of them is invalid or none is given.
   */
  private readTargets (slug: string, value: unknown): string[] | null {
    const entries = Array.isArray(value) ? value : value === undefined ? [] : [value]
    if (!entries.length) {
      this.addWarning(slug, 'must be <port> | <host>:<port> | <URL>, or a list of them')
      return null
    }

    const targets: string[] = []
    for (const entry of entries) {
      const written = typeof entry === 'number' ? String(entry) : typeof entry === 'string' ? entry.trim() : ''
      const text = /^\d+$/.test(written) ? `127.0.0.1:${written}` : written
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
      const url = URL.parse(withScheme ? text : `http://${text}`)
      if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.port === '0' || (!withScheme && !/:\d+$/.test(text))) {
        this.addWarning(slug, `${String(entry)} is not a port, <host>:<port> or http(s) URL`)
        return null
      }
      targets.push(url.toString())
    }
    return targets
  }

  /**
   * Reads the folders of editable files a directory declares, which may not exist yet.
   * @param slug Names the setting in warnings.
   * @param directory The directory, its extras already read.
   * @param value The raw setting.
   * @param inherited The MCP rules of the folders of files of the directory.
   * @returns The folders by slug.
   */
  private readFiles (slug: string, directory: DirectoryDefinition, value: unknown, inherited: McpRules): Record<string, DirectoryFiles> {
    const files: Record<string, DirectoryFiles> = {}
    for (const [filesSlug, filesRaw] of Object.entries(toRecord(value))) {
      if (filesSlug === 'default') {
        this.addWarning(`${slug}.default`, 'is replaced by default: { action: files:<slug> }')
        continue
      }

      const entry = toRecord(filesRaw)
      if (!this.checkSlug(`${slug}[${filesSlug}]`, filesSlug) || !this.checkString(`${slug}[${filesSlug}].path`, entry.path)) {
        continue
      }

      const commands = toStringArray(entry.commands) ?? []
      const unknownCommands = commands.filter(command => !(command in directory.extras))
      if (unknownCommands.length) {
        this.addWarning(`${slug}[${filesSlug}].commands`, `unknown commands ${unknownCommands.join(', ')}`)
      }
      const restore = typeof entry.restore === 'string' && entry.restore in directory.extras ? entry.restore : null
      if (entry.restore !== undefined && !restore) {
        this.addWarning(`${slug}[${filesSlug}].restore`, 'must name a command of the directory')
      }
      const type = FILES_TYPES.find(candidate => candidate === (entry.type ?? 'files'))
      if (!type) {
        this.addWarning(`${slug}[${filesSlug}].type`, `must be ${FILES_TYPES.join(' or ')}`)
        continue
      }

      files[filesSlug] = {
        slug: filesSlug,
        name: typeof entry.name === 'string' ? entry.name : filesSlug,
        type,
        path: this.pathFrom(directory.path, entry.path as string),
        restore,
        commands: commands.filter(command => command in directory.extras),
        mcp: this.readMcpRules(`${slug}[${filesSlug}].mcp`, entry.mcp, inherited, ['projects', directory.slug, 'files', filesSlug]),
        mcpTarget: this.settingTarget(['projects', directory.slug, 'files', filesSlug, 'mcp']),
        mcpSkills: this.readMcpSkills(`${slug}[${filesSlug}].mcpSkills`, entry.mcpSkills, type),
        showHidden: this.readFlag(`${slug}[${filesSlug}].showHidden`, entry.showHidden, false)
      }
    }
    return files
  }

  /**
   * Reads a setting being true or false, warning about any other value.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @param fallback The value when the setting is missing or invalid.
   * @returns The value.
   */
  private readFlag (slug: string, value: unknown, fallback: boolean): boolean {
    if (value !== undefined && typeof value !== 'boolean') {
      this.addWarning(slug, 'must be true or false')
    }
    return typeof value === 'boolean' ? value : fallback
  }

  /**
   * Reads which skills of a folder of files are served to the agents, `mcpSkills: true` for all of them
   * or a list of globs matching their folders.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @param type The type of the folder of files.
   * @returns The globs of the served skill folders, null when none is served.
   */
  private readMcpSkills (slug: string, value: unknown, type: DirectoryFilesType): string[] | null {
    if (value === undefined || value === false) {
      return null
    }
    if (type !== 'agentSkills') {
      this.addWarning(slug, 'only applies to files of type agentSkills')
      return null
    }
    const globs = value === true ? ['*'] : toStringArray(value)
    if (!globs?.length) {
      this.addWarning(slug, 'must be true or a list of skill folders, such as [ review, "deploy-*" ]')
      return null
    }
    return globs
  }

  private pathFrom (projectPath: string, directoryPath?: string): string {
    const base = path.isAbsolute(projectPath) ? projectPath : path.join(process.cwd(), projectPath)
    if (!directoryPath) {
      return base
    }
    return path.isAbsolute(directoryPath) ? directoryPath : path.join(base, directoryPath)
  }

  private async checkDirectory (slug: string, directory: string, mustBeAbsolute = false): Promise<boolean> {
    try {
      if (mustBeAbsolute && !path.isAbsolute(directory)) {
        throw new Error('must be an absolute directory')
      }

      const stat = await fs.stat(directory)
      if (!stat.isDirectory()) {
        throw new Error('not a directory')
      }
      return true
    } catch (error) {
      this.addWarning(slug, error instanceof Error ? error.message : 'invalid directory')
      return false
    }
  }

  private checkSlug (slug: string, value: unknown): boolean {
    if (typeof value !== 'string') {
      this.addWarning(slug, 'is not a string')
      return false
    }

    if (!SLUG_REGEXP.test(value)) {
      this.addWarning(slug, 'is not a slug (a-z0-9-/_.)')
      return false
    }

    return true
  }

  private checkString (slug: string, value: unknown): boolean {
    if (typeof value !== 'string') {
      this.addWarning(slug, 'is not a string')
      return false
    }

    return true
  }

  /**
   * Reads an optional text setting, warning when it is given but is not a text.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @param fallback The value used when the setting is absent or invalid.
   * @returns The text of the setting, else the fallback.
   */
  private readOptionalString (slug: string, value: unknown, fallback: string): string {
    if (value === undefined) {
      return fallback
    }
    return this.checkString(slug, value) ? (value as string) : fallback
  }

  private readKillSignal (slug: string, value: unknown): string | null {
    if (value === undefined || value === null) {
      return null
    }

    if (typeof value !== 'string') {
      this.addWarning(slug, 'is not a string')
      return null
    }

    const normalized = value.trim().toUpperCase()
    if (!normalized.length) {
      return null
    }

    if (!SIGNAL_REGEXP.test(normalized)) {
      this.addWarning(slug, 'must match SIG* format (example: SIGTERM, SIGKILL)')
      return null
    }

    return normalized
  }

  private readShell (slug: string, value: unknown): string | null {
    if (value === undefined || value === null) {
      return null
    }

    if (typeof value !== 'string') {
      this.addWarning(slug, 'is not a string')
      return null
    }

    const normalized = value.trim()
    if (!normalized.length) {
      return null
    }

    return normalized
  }

  private addWarning (slug: string, message: string): false {
    logger.warn('Config', slug, message)
    this.warnings.push(`${slug}: ${message}.`)
    return false
  }
}
