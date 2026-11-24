import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configSourceKey } from '@appsys/devtool-config'
import { DEFAULT_AGENT_PROMPTS, logger } from '@appsys/devtool-shared'
import type { DirectoryDefinition, McpRules } from '@appsys/devtool-shared'
import { agentAutomationKey, certificateAutomationKey, DevtoolConfigure, integrationAutomationKey } from '../../src/configure.js'
import type { ConfigOrigin } from '../../src/types.js'

const API = 'projects[main].directories[api]'
const SERVICE = `${API}.services[web]`
const FREE_ARGUMENTS = { name: 'arguments', kind: 'text', choices: [], display: 'buttons', optional: true, default: null }

let workspace: string

/**
 * Reads a raw configuration from scratch.
 * @param raw - The raw configuration.
 * @param origin - Where its settings come from.
 * @returns The configuration once read.
 */
async function load (raw: Record<string, unknown>, origin?: ConfigOrigin): Promise<DevtoolConfigure> {
  const configure = new DevtoolConfigure(raw, origin)
  await configure.reconfigure()
  return configure
}

/**
 * Builds a raw directory named after its slug, held by the folder of the same name.
 * @param slug - The slug of the directory.
 * @param settings - Its other settings.
 * @returns The raw directory.
 */
function directory (slug: string, settings: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: slug.toUpperCase(), path: slug, ...settings }
}

/**
 * Builds a raw configuration whose only section, `main`, is the workspace.
 * @param directories - The raw directories of the section, by slug.
 * @param section - The other settings of the section.
 * @param root - The other settings of the configuration.
 * @returns The raw configuration.
 */
function sectionConfig (directories: Record<string, unknown>, section: Record<string, unknown> = {}, root: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...root, projects: { main: { name: 'Main', path: workspace, directories, ...section } } }
}

/**
 * Reads a configuration whose section `main` holds the directory `api` only.
 * @param settings - The settings of the directory.
 * @param section - The other settings of the section.
 * @param root - The other settings of the configuration.
 * @returns The configuration once read.
 */
async function loadApi (settings: Record<string, unknown> = {}, section: Record<string, unknown> = {}, root: Record<string, unknown> = {}): Promise<DevtoolConfigure> {
  return load(sectionConfig({ api: directory('api', settings) }, section, root))
}

/**
 * Gives the directory `api` of the section `main`.
 * @param configure - The configuration once read.
 * @returns The directory.
 */
function apiOf (configure: DevtoolConfigure): DirectoryDefinition {
  return configure.projects.main.directories.api
}

/**
 * Tells whether a warning matches a pattern.
 * @param configure - The configuration once read.
 * @param pattern - The pattern of the warning.
 * @returns True when one of the warnings matches.
 */
function hasWarning (configure: DevtoolConfigure, pattern: RegExp): boolean {
  return configure.warnings.some(warning => pattern.test(warning))
}

/**
 * Gives the same level for every action, from one setting.
 * @param level - The level.
 * @param from - The setting the rules come from.
 * @returns The rules.
 */
function rulesOf (level: string, from: string): McpRules {
  return Object.fromEntries(['read', 'run', 'input', 'control', 'write'].map(action => [action, { level, from }])) as McpRules
}

/**
 * Creates a folder of the workspace.
 * @param segments - The path of the folder from the workspace.
 * @returns Its absolute path.
 */
async function makeFolder (...segments: string[]): Promise<string> {
  const folder = path.join(workspace, ...segments)
  await fs.mkdir(folder, { recursive: true })
  return folder
}

/**
 * Writes a file of the workspace.
 * @param relativePath - The path of the file from the workspace.
 * @param content - Its content.
 * @param mode - Its permissions.
 * @returns Its absolute path.
 */
async function writeFile (relativePath: string, content: string, mode = 0o644): Promise<string> {
  const file = path.join(workspace, relativePath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, { mode })
  await fs.chmod(file, mode)
  return file
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'configure-spec-'))
  await makeFolder('api')
  await makeFolder('web')
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
  vi.spyOn(logger, 'info').mockImplementation(() => undefined)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(workspace, { recursive: true, force: true })
})

describe('automation keys', () => {
  it('names the automations of certificates, integrations and agents', () => {
    expect(certificateAutomationKey('main')).toBe('loadBalancers/main/acme')
    expect(integrationAutomationKey('web/api/github')).toBe('integrations/web/api/github')
    expect(agentAutomationKey('claude')).toBe('agents/claude')
  })
})

describe('defaults', () => {
  it('starts empty before the configuration is read', () => {
    const configure = new DevtoolConfigure({ projects: { main: {} } })
    expect(configure.warnings).toEqual([])
    expect(configure.projects).toEqual({})
    expect(configure.localPath).toBeNull()
  })

  it('reads an empty configuration without warnings', async () => {
    const configure = await load({})
    expect(configure.warnings).toEqual([])
    expect(configure.projects).toEqual({})
    expect(configure.integrations).toEqual([])
    expect(configure.loadBalancers).toEqual({})
    expect(configure.passthrough).toEqual([])
    expect(configure.dns).toBeNull()
    expect(configure.automations).toEqual({})
    expect(configure.integrationTokens).toEqual({})
  })

  it('gives the default settings of the devtool', async () => {
    const { adt } = await load({})
    expect(adt).toMatchObject({
      name: 'appsys-devtool',
      displayName: 'AppSys Devtool',
      icon: null,
      host: null,
      shell: null,
      ports: { server: 6730, loadBalancer: 6731 },
      notifications: true,
      access: 'local',
      sidebar: { environment: false, configs: false, login: false, sort: 'config', order: [], sections: [] },
      agents: []
    })
    expect(adt.cacheDir).toBe(path.join(os.homedir(), '.cache/appsys/devtool'))
  })

  it('gives the default MCP settings', async () => {
    const { adt } = await load({})
    const rules = rulesOf('ask', 'default')
    rules.read = { level: 'allow', from: 'default' }
    expect(adt.mcp).toEqual({
      enabled: false,
      notifications: true,
      timeout: 120,
      default: rules,
      commands: rules,
      scripts: rules,
      files: rules,
      terminals: rules,
      certificates: rules,
      devtool: rules,
      clients: { level: 'ask', allow: [], deny: [] },
      ownTerminals: 'allow',
      shell: { level: 'deny', allow: [], deny: [] },
      environment: rules,
      environmentItems: []
    })
  })

  it('reads the configuration again from scratch', async () => {
    const configure = new DevtoolConfigure({ passthrough: 'all' })
    await configure.reconfigure()
    await configure.reconfigure()
    expect(configure.warnings).toEqual(['passthrough: must be an array.'])
  })

  it('gives the configuration the server runs with', async () => {
    const configure = await load({ integrations: { mail: { name: 'Mail', url: 'https://mail.example.dev' } } })
    expect(configure.runtimeConfig).toEqual({
      adt: configure.adt,
      loadBalancers: configure.loadBalancers,
      passthrough: configure.passthrough,
      dns: configure.dns,
      integrations: configure.integrations,
      projects: configure.projects,
      warnings: configure.warnings
    })
  })
})

describe('adt', () => {
  it('reads the host, interface, cache, ports, access, notifications and shell', async () => {
    const { adt, warnings } = await load({
      adt: {
        host: 'devtool.example.dev',
        uiPath: '/opt/ui',
        cacheDir: '/opt/cache',
        ports: { server: 7000, loadBalancer: 7001 },
        notifications: false,
        access: 'network',
        shell: '  /bin/zsh  '
      }
    })
    expect(warnings).toEqual([])
    expect(adt).toMatchObject({
      host: 'devtool.example.dev',
      uiPath: '/opt/ui',
      cacheDir: '/opt/cache',
      ports: { server: 7000, loadBalancer: 7001 },
      notifications: false,
      access: 'network',
      shell: '/bin/zsh'
    })
  })

  it('keeps the default ports when the declared ones are not positive integers', async () => {
    const { adt, warnings } = await load({ adt: { ports: { server: 0, loadBalancer: 'x' } } })
    expect(adt.ports).toEqual({ server: 6730, loadBalancer: 6731 })
    expect(warnings).toEqual([])
  })

  it('warns about an invalid access and uses local', async () => {
    const { adt, warnings } = await load({ adt: { access: 'everyone' } })
    expect(adt.access).toBe('local')
    expect(warnings).toEqual(['adt.access: must be local or network, local is used.'])
  })

  it('warns about a shell that is not a string and ignores an empty one', async () => {
    expect((await load({ adt: { shell: 5 } })).warnings).toEqual(['adt.shell: is not a string.'])
    const blank = await load({ adt: { shell: '   ' } })
    expect(blank.adt.shell).toBeNull()
    expect(blank.warnings).toEqual([])
  })

  it('names the devtool after its display name', async () => {
    const { adt, warnings } = await load({ adt: { displayName: 'Web Tools' } })
    expect(adt.displayName).toBe('Web Tools')
    expect(adt.name).toBe('web-tools')
    expect(warnings).toEqual([])
  })

  it('warns about an invalid name, display name or icon', async () => {
    const { adt, warnings } = await load({ adt: { name: 'Bad Name', displayName: 'a/b', icon: 'icon.txt' } })
    expect(adt.name).toBe('appsys-devtool')
    expect(adt.displayName).toBe('AppSys Devtool')
    expect(adt.icon).toBeNull()
    expect(warnings).toEqual([
      'adt.displayName: must be a text without /.',
      'adt.name: must hold lowercase letters, digits, - and _ only.',
      'adt.icon: must be a .svg, .png, .jpg, .jpeg, .icns file.'
    ])
  })

  it('keeps an icon file and warns about a missing one', async () => {
    const icon = await writeFile('icon.svg', '<svg/>')
    expect((await load({ adt: { icon } })).adt.icon).toBe(icon)
    const missing = path.join(workspace, 'missing.svg')
    const configure = await load({ adt: { icon: missing } })
    expect(configure.adt.icon).toBeNull()
    expect(configure.warnings).toEqual([`adt.icon: ${missing} does not exist.`])
  })

  it('shows the optional parts of the sidebar', async () => {
    const { adt, warnings } = await load({ adt: { sidebar: { environment: true, configs: 'yes', login: false } } })
    expect(adt.sidebar).toMatchObject({ environment: true, configs: false, login: false })
    expect(warnings).toEqual(['adt.sidebar.configs: is not a boolean.'])
  })

  it('warns about an invalid sort or order of the sidebar', async () => {
    const { adt, warnings } = await load({ adt: { sidebar: { sort: 'random', order: 'api' } } })
    expect(adt.sidebar.sort).toBe('config')
    expect(adt.sidebar.order).toEqual([])
    expect(warnings).toEqual(['adt.sidebar.sort: must be config, name, manual.', 'adt.sidebar.order: must be a list.'])
  })
})

describe('sidebar sections', () => {
  /**
   * Reads two sections, `web` named Zeta then `api` named Alpha, ordered by the sidebar settings.
   * @param sidebar - The raw `adt.sidebar`.
   * @returns The configuration once read.
   */
  async function loadSections (sidebar: Record<string, unknown>): Promise<DevtoolConfigure> {
    return load({
      adt: { sidebar },
      projects: {
        web: { name: 'Zeta', path: path.join(workspace, 'web'), directories: { app: { name: 'App', path: '.' } } },
        api: { name: 'Alpha', path: path.join(workspace, 'api'), directories: { app: { name: 'App', path: '.' } } }
      }
    })
  }

  it('keeps the order of the configuration by default', async () => {
    const { adt, warnings } = await loadSections({})
    expect(warnings).toEqual([])
    expect(adt.sidebar.sections).toEqual(['web', 'api'])
  })

  it('orders the sections by name', async () => {
    expect((await loadSections({ sort: 'name' })).adt.sidebar.sections).toEqual(['api', 'web'])
  })

  it('orders the sections by hand, warning about keys naming nothing', async () => {
    const { adt, warnings } = await loadSections({ sort: 'manual', order: ['ghost', 'api'] })
    expect(adt.sidebar.sections).toEqual(['api', 'web'])
    expect(warnings).toEqual(['adt.sidebar.order: ghost names nothing here.'])
  })
})

describe('adt.agents', () => {
  it('reads agents run in a terminal or opened by a link', async () => {
    const configure = await load({
      adt: {
        agents: {
          'claude-code': { name: 'Claude Code', icon: 'simple-icons:claude', args: ['claude', '%{ADT:PROMPT}', 3] },
          'claude-desktop': { name: 'Claude Desktop', url: 'claude://code/new?q=%{ADT:PROMPT}', env: { MODE: 'fast' } }
        }
      }
    })
    expect(configure.warnings).toEqual([])
    expect(configure.adt.agents).toEqual([
      { slug: 'claude-code', name: 'Claude Code', icon: 'simple-icons:claude', args: ['claude', '%{ADT:PROMPT}', '3'], url: null, env: {} },
      { slug: 'claude-desktop', name: 'Claude Desktop', icon: 'lucide:bot', args: null, url: 'claude://code/new?q=%{ADT:PROMPT}', env: { MODE: 'fast' } }
    ])
    expect(configure.automations).toEqual({})
    expect(configure.getForClient('1.0.0').agents).toBe(configure.adt.agents)
  })

  it('keeps the automation of an agent', async () => {
    const configure = await load({ adt: { agents: { codex: { name: 'Codex', args: ['codex'], env: { TOKEN: '{{ op://vault/codex/token }}' }, opAccount: 'team.example.dev' } } } })
    expect(configure.automations[agentAutomationKey('codex')]).toEqual({ unless: null, opAccount: 'team.example.dev', answers: [] })
  })

  it('warns about invalid agents', async () => {
    const configure = await load({
      adt: {
        agents: {
          'bad slug': { name: 'Bad', args: ['x'] },
          'unnamed': { args: ['x'] },
          'icon': { name: 'Icon', icon: 5, args: ['x'] },
          'both': { name: 'Both', args: ['x'], url: 'https://agent.example.dev' },
          'none': { name: 'None' },
          'empty': { name: 'Empty', args: [] },
          'link': { name: 'Link', url: 5 }
        }
      }
    })
    expect(configure.adt.agents).toEqual([])
    expect(configure.warnings).toEqual([
      'adt.agents.bad slug: is not a slug (a-z0-9-/_.).',
      'adt.agents.unnamed.name: is not a string.',
      'adt.agents.icon.icon: is not a string.',
      'adt.agents.both: needs either args, run in a terminal, or url, opened by the interface.',
      'adt.agents.none: needs either args, run in a terminal, or url, opened by the interface.',
      'adt.agents.empty.args: must be a non-empty array of strings or numbers.',
      'adt.agents.link.url: is not a string.'
    ])
  })

  it('warns about agents that are not a map', async () => {
    const configure = await load({ adt: { agents: ['claude'] } })
    expect(configure.adt.agents).toEqual([])
    expect(configure.warnings).toEqual(['adt.agents: must be a map of agents.'])
  })
})

describe('adt.agentPrompts', () => {
  it('warns about prompts that are not a map', async () => {
    expect((await load({ adt: { agentPrompts: 'review' } })).warnings).toEqual(['adt.agentPrompts: must be a map of prompts by kind of integration.'])
  })

  it('warns about unknown kinds, unknown actions and prompts that are not texts', async () => {
    const configure = await load({ adt: { agentPrompts: { merges: {}, issues: { review: 'Review', analyze: 5 }, pullRequests: 'Review' } } })
    expect(configure.warnings).toEqual([
      'adt.agentPrompts.merges: is not a kind of integration, expected pullRequests or issues.',
      'adt.agentPrompts.issues.review: is not an action of issues, which offer analyze, fix.',
      'adt.agentPrompts.issues.analyze: is not a string.',
      'adt.agentPrompts.pullRequests: must be a map of prompts by action.'
    ])
  })
})

describe('adt.mcp', () => {
  it('reads the switches, timeout and terminals of the server', async () => {
    const { adt, warnings } = await load({ adt: { mcp: { enabled: true, notifications: false, timeout: 30, ownTerminals: 'ask' } } })
    expect(warnings).toEqual([])
    expect(adt.mcp).toMatchObject({ enabled: true, notifications: false, timeout: 30, ownTerminals: 'ask' })
  })

  it('notifies the requests of agents as the devtool notifies by default', async () => {
    expect((await load({ adt: { notifications: false } })).adt.mcp.notifications).toBe(false)
  })

  it('warns about invalid switches, timeout and terminals', async () => {
    const { adt, warnings } = await load({ adt: { mcp: { enabled: 'yes', notifications: 1, timeout: 0, ownTerminals: 'never' } } })
    expect(adt.mcp).toMatchObject({ enabled: false, notifications: true, timeout: 120, ownTerminals: 'allow' })
    expect(warnings).toEqual([
      'adt.mcp.enabled: is not a boolean.',
      'adt.mcp.notifications: is not a boolean.',
      'adt.mcp.timeout: must be a positive number of seconds.',
      'adt.mcp.ownTerminals: must be allow or ask.'
    ])
  })

  it('applies the default rules to every category, each refining them', async () => {
    const { adt, warnings } = await load({ adt: { mcp: { default: 'deny', commands: { run: 'allow' } } } })
    expect(warnings).toEqual([])
    expect(adt.mcp.default).toEqual(rulesOf('deny', 'adt.mcp.default'))
    expect(adt.mcp.terminals).toEqual(rulesOf('deny', 'adt.mcp.default'))
    expect(adt.mcp.environment).toEqual(rulesOf('deny', 'adt.mcp.default'))
    expect(adt.mcp.commands).toEqual({ ...rulesOf('deny', 'adt.mcp.default'), run: { level: 'allow', from: 'adt.mcp.commands' } })
  })

  it('accepts the keys level for files only', async () => {
    const configure = await load({ adt: { mcp: { default: 'keys', files: 'keys' } } })
    expect(configure.warnings).toEqual(['adt.mcp.default: keys is for the settings of files only.'])
    expect(configure.adt.mcp.files.read).toEqual({ level: 'keys', from: 'adt.mcp.files' })
    expect(configure.adt.mcp.files.write).toEqual({ level: 'keys', from: 'adt.mcp.files' })
    expect(configure.adt.mcp.files.run).toEqual({ level: 'ask', from: 'default' })
  })

  it('warns about unknown actions and levels', async () => {
    const { warnings } = await load({ adt: { mcp: { scripts: { fly: 'allow', run: 'maybe' }, devtool: 5 } } })
    expect(warnings).toEqual([
      'adt.mcp.scripts: fly is not an action (read, run, input, control, write).',
      'adt.mcp.scripts: run must be one of allow, ask, deny.',
      'adt.mcp.devtool: must be one of allow, keys, ask, deny, or levels by action (read, run, input, control, write).'
    ])
  })

  it('reads the levels and patterns of clients and shell commands', async () => {
    const { adt, warnings } = await load({ adt: { mcp: { clients: { level: 'keys', allow: ['claude*'] }, shell: { level: 'allow', allow: ['git *'], deny: 'rm' } } } })
    expect(adt.mcp.clients).toEqual({ level: 'ask', allow: ['claude*'], deny: [] })
    expect(adt.mcp.shell).toEqual({ level: 'allow', allow: ['git *'], deny: [] })
    expect(warnings).toEqual(['adt.mcp.clients.level: must be allow, ask or deny.', 'adt.mcp.shell.deny: must be an array of patterns.'])
  })

  it('reads the rules of the environment and of its items', async () => {
    const { adt, warnings } = await load({
      environment: {
        mcp: 'deny',
        files: ['shared/app.yml', { path: 'db.yml', mcp: 'allow' }, { mcp: 'allow' }],
        databases: [{ path: 'main', mcp: 'keys' }],
        buckets: 'assets'
      }
    })
    expect(adt.mcp.environment).toEqual(rulesOf('deny', 'environment'))
    expect(adt.mcp.environmentItems).toEqual([
      { path: 'shared/app.yml', kind: 'file', rules: rulesOf('deny', 'environment'), target: { path: ['environment', 'files', '0', 'mcp'], declaredIn: null } },
      { path: 'db.yml', kind: 'file', rules: rulesOf('allow', 'environment.files.1'), target: { path: ['environment', 'files', '1', 'mcp'], declaredIn: null } },
      { path: 'main', kind: 'database', rules: rulesOf('deny', 'environment'), target: { path: ['environment', 'databases', '0', 'mcp'], declaredIn: null } }
    ])
    expect(warnings).toEqual(['environment.databases.0.mcp: keys is for the settings of files only.'])
  })
})

describe('loadBalancers', () => {
  it('reads a certificate under its domain', async () => {
    const configure = await load({ loadBalancers: { 'example.dev': { crt: 'certs/example.dev.crt', key: 'certs/example.dev.key' } } })
    expect(configure.warnings).toEqual([])
    expect(configure.loadBalancers).toEqual({
      '.example.dev': {
        crt: 'certs/example.dev.crt',
        key: 'certs/example.dev.key',
        warn: 30,
        acme: null,
        mcp: configure.adt.mcp.certificates,
        mcpTarget: { path: ['loadBalancers', 'example.dev', 'mcp'], declaredIn: null }
      }
    })
  })

  it('keeps a domain already starting with a dot and its warning delay', async () => {
    const configure = await load({ loadBalancers: { '.example.dev': { crt: 'a.crt', key: 'a.key', warn: 10 } } })
    expect(Object.keys(configure.loadBalancers)).toEqual(['.example.dev'])
    expect(configure.loadBalancers['.example.dev'].warn).toBe(10)
  })

  it('warns about invalid names, files and warning delays', async () => {
    const configure = await load({
      loadBalancers: {
        'bad host': { crt: 'a.crt', key: 'a.key' },
        'no-crt.example.dev': { key: 'a.key' },
        'no-key.example.dev': { crt: 'a.crt', key: 5 },
        'warn.example.dev': { crt: 'a.crt', key: 'a.key', warn: 0 }
      }
    })
    expect(Object.keys(configure.loadBalancers)).toEqual(['.warn.example.dev'])
    expect(configure.loadBalancers['.warn.example.dev'].warn).toBe(30)
    expect(configure.warnings).toEqual([
      'loadBalancers[bad host]: is not a slug (a-z0-9-/_.).',
      'loadBalancers[no-crt.example.dev].crt: is not a string.',
      'loadBalancers[no-key.example.dev].key: is not a string.',
      'loadBalancers[warn.example.dev].warn: must be a positive number of days.'
    ])
  })

  it('reads the MCP rules of a certificate over those of certificates', async () => {
    const configure = await load({ adt: { mcp: { certificates: { read: 'deny' } } }, loadBalancers: { 'example.dev': { crt: 'a.crt', key: 'a.key', mcp: { run: 'allow' } } } })
    expect(configure.loadBalancers['.example.dev'].mcp).toMatchObject({
      read: { level: 'deny', from: 'adt.mcp.certificates' },
      run: { level: 'allow', from: 'loadBalancers.example.dev' },
      write: { level: 'ask', from: 'default' }
    })
  })

  it('reads a renewal by lego, leaving out the options the devtool sets', async () => {
    const configure = await load({
      loadBalancers: {
        'example.dev': {
          crt: 'a.crt',
          key: 'a.key',
          acme: {
            trigger: 'both',
            before: 20,
            env: { TOKEN: '{{ op://vault/dns/token }}' },
            lego: { 'domains': ['example.dev', '*.example.dev'], 'email': 'certs@example.dev', 'path': '/tmp', 'accept-tos': true, 'dns': { name: 'x' } }
          }
        }
      }
    })
    expect(configure.loadBalancers['.example.dev'].acme).toEqual({
      trigger: 'both',
      before: 20,
      env: { TOKEN: '{{ op://vault/dns/token }}' },
      lego: { domains: ['example.dev', '*.example.dev'], email: 'certs@example.dev' },
      command: null
    })
    expect(configure.warnings).toEqual([
      'loadBalancers[example.dev].acme.lego.path: is set by the devtool.',
      'loadBalancers[example.dev].acme.lego.accept-tos: is set by the devtool.',
      'loadBalancers[example.dev].acme.lego.dns: must be a string, a number, a boolean or a list of strings or numbers.'
    ])
    expect(configure.automations[certificateAutomationKey('example.dev')]).toEqual({ unless: null, opAccount: null, answers: [] })
  })

  it('reads a renewal by a command with the default trigger and delay', async () => {
    const configure = await load({ loadBalancers: { 'example.dev': { crt: 'a.crt', key: 'a.key', acme: { command: ['./renew.sh', '%{ADT:CRT}', 1] } } } })
    expect(configure.warnings).toEqual([])
    expect(configure.loadBalancers['.example.dev'].acme).toEqual({ trigger: 'button', before: 30, env: {}, lego: null, command: ['./renew.sh', '%{ADT:CRT}', '1'] })
    expect(configure.automations).toEqual({})
  })

  it.each<[string, Record<string, unknown>, Record<string, unknown>, string]>([
    ['PEM texts', { crt: '-----BEGIN CERTIFICATE-----', key: 'a.key' }, { lego: {} }, 'acme: needs crt and key to be files, not PEM texts.'],
    ['both tools', { crt: 'a.crt', key: 'a.key' }, { lego: {}, command: ['x'] }, 'acme: needs either lego or command.'],
    ['no tool', { crt: 'a.crt', key: 'a.key' }, {}, 'acme: needs either lego or command.'],
    ['an unknown trigger', { crt: 'a.crt', key: 'a.key' }, { lego: {}, trigger: 'never' }, 'acme.trigger: must be button, auto or both.'],
    ['a delay that is not positive', { crt: 'a.crt', key: 'a.key' }, { lego: {}, before: 0 }, 'acme.before: must be a positive number of days.'],
    ['an empty command', { crt: 'a.crt', key: 'a.key' }, { command: [] }, 'acme.command: must be a non-empty array of strings or numbers.']
  ])('refuses a renewal with %s', async (_label, files, acme, warning) => {
    const configure = await load({ loadBalancers: { 'example.dev': { ...files, acme } } })
    expect(configure.loadBalancers['.example.dev'].acme).toBeNull()
    expect(configure.warnings).toEqual([`loadBalancers[example.dev].${warning}`])
  })

  it('shows the certificates to the interfaces by name', async () => {
    const configure = await load({ loadBalancers: { 'example.dev': { crt: 'a.crt', key: 'a.key' } } })
    const client = configure.getForClient('1.0.0')
    expect(client.loadBalancers).toEqual(['.example.dev'])
    expect(client.mcp.certificatesByName).toEqual({
      'example.dev': { rules: configure.loadBalancers['.example.dev'].mcp, target: { path: ['loadBalancers', 'example.dev', 'mcp'], declaredIn: null } }
    })
  })
})

describe('passthrough', () => {
  it('reads the hosts forwarded untouched, in lowercase', async () => {
    const configure = await load({ passthrough: [{ hosts: ['Example.dev', '*.example.dev'], target: '127.0.0.1:8443', access: 'network' }, { hosts: ['web.example.dev'], target: 'localhost:9443' }] })
    expect(configure.warnings).toEqual([])
    expect(configure.passthrough).toEqual([
      { hosts: ['example.dev', '*.example.dev'], host: '127.0.0.1', port: 8443, access: 'network' },
      { hosts: ['web.example.dev'], host: 'localhost', port: 9443, access: 'local' }
    ])
  })

  it('warns about a setting that is not a list', async () => {
    const configure = await load({ passthrough: { hosts: ['example.dev'] } })
    expect(configure.passthrough).toEqual([])
    expect(configure.warnings).toEqual(['passthrough: must be an array.'])
  })

  it('warns about invalid hosts, targets and access', async () => {
    const configure = await load({
      passthrough: [
        { hosts: ['bad host'], target: '127.0.0.1:8443' },
        { hosts: [], target: '127.0.0.1:8443' },
        { hosts: ['example.dev'], target: '127.0.0.1' },
        { hosts: ['example.dev'], target: '127.0.0.1:8443', access: 'world' },
        { hosts: ['example.dev'], target: '127.0.0.1:0' },
        { hosts: ['example.dev'], target: '127.0.0.1:65536' }
      ]
    })
    expect(configure.passthrough).toEqual([{ hosts: ['example.dev'], host: '127.0.0.1', port: 8443, access: 'local' }])
    expect(configure.warnings).toEqual([
      'passthrough[0].hosts: must be host names or *.<domain>.',
      'passthrough[1].hosts: must be host names or *.<domain>.',
      'passthrough[2].target: must be <host>:<port>, the port between 1 and 65535.',
      'passthrough[3].access: must be local or network, local is used.',
      'passthrough[4].target: must be <host>:<port>, the port between 1 and 65535.',
      'passthrough[5].target: must be <host>:<port>, the port between 1 and 65535.'
    ])
  })
})

describe('dns', () => {
  it('reads the records, port and access', async () => {
    const configure = await load({
      dns: {
        port: '5353',
        access: 'network',
        records: {
          dev: { names: ['Example.dev', '*.example.dev'], address: 'auto' },
          lan: { names: ['lan.example.dev'], address: '192.168.1.20' }
        }
      }
    })
    expect(configure.warnings).toEqual([])
    expect(configure.dns).toEqual({
      port: 5353,
      access: 'network',
      records: [
        { names: ['example.dev', '*.example.dev'], address: 'auto' },
        { names: ['lan.example.dev'], address: '192.168.1.20' }
      ]
    })
  })

  it('listens on port 53 for this machine by default', async () => {
    const configure = await load({ dns: { records: { dev: { names: ['example.dev'], address: '127.0.0.1' } } } })
    expect(configure.dns).toMatchObject({ port: 53, access: 'local' })
  })

  it('warns about invalid records and gives no DNS without a valid one', async () => {
    const configure = await load({ dns: { records: { names: { names: ['bad name'], address: 'auto' }, address: { names: ['example.dev'], address: '::1' }, missing: {} } } })
    expect(configure.dns).toBeNull()
    expect(configure.warnings).toEqual([
      'dns.records[names].names: must be host names or *.<domain>.',
      'dns.records[address].address: must be an IPv4 address or auto.',
      'dns.records[missing].names: must be host names or *.<domain>.'
    ])
  })

  it('warns about an invalid port', async () => {
    const configure = await load({ dns: { port: 70000, records: { dev: { names: ['example.dev'], address: 'auto' } } } })
    expect(configure.dns).toBeNull()
    expect(configure.warnings).toEqual(['dns.port: must be a port number.'])
  })
})

describe('integrations', () => {
  it('reads web integrations in the order they are declared', async () => {
    const configure = await load({
      integrations: {
        mail: { name: 'Mail', url: 'https://mail.example.dev' },
        docs: { name: 'Docs', type: 'web', icon: 'mdi:book', url: 'http://docs.example.dev/path', embed: false }
      }
    })
    expect(configure.warnings).toEqual([])
    expect(configure.integrations).toEqual([
      { slug: 'mail', name: 'Mail', type: 'web', icon: 'lucide:app-window', url: 'https://mail.example.dev', embed: true, provider: null, agentActions: [], agentPrompts: {}, badge: false, refresh: 0 },
      { slug: 'docs', name: 'Docs', type: 'web', icon: 'mdi:book', url: 'http://docs.example.dev/path', embed: false, provider: null, agentActions: [], agentPrompts: {}, badge: false, refresh: 0 }
    ])
    expect(configure.getForClient('1.0.0').integrations).toBe(configure.integrations)
  })

  it('warns about integrations that are not a map', async () => {
    const configure = await load({ integrations: [{ name: 'Mail' }] })
    expect(configure.integrations).toEqual([])
    expect(configure.warnings).toEqual(['integrations: must be a map of integrations.'])
  })

  it('warns about invalid slugs, names, types, icons, URLs and embedding', async () => {
    const configure = await load({
      integrations: {
        'bad slug': { name: 'Bad', url: 'https://bad.example.dev' },
        'unnamed': { url: 'https://unnamed.example.dev' },
        'chat': { name: 'Chat', type: 'chat', url: 'https://chat.example.dev' },
        'icon': { name: 'Icon', icon: 5, url: 'https://icon.example.dev' },
        'ftp': { name: 'FTP', url: 'ftp://files.example.dev' },
        'nourl': { name: 'No URL' },
        'embed': { name: 'Embed', url: 'https://embed.example.dev', embed: 'yes' }
      }
    })
    expect(configure.integrations).toEqual([])
    expect(configure.warnings).toEqual([
      'integrations.bad slug: is not a slug (a-z0-9-/_.).',
      'integrations.unnamed.name: is not a string.',
      'integrations.chat.type: must be web or pullRequests or issues.',
      'integrations.icon.icon: is not a string.',
      'integrations.ftp.url: must be an http or https URL.',
      'integrations.nourl.url: must be an http or https URL.',
      'integrations.embed.embed: must be true or false.'
    ])
  })

  it('refuses pull requests and issues at the root', async () => {
    const configure = await load({ integrations: { pulls: { name: 'Pulls', type: 'pullRequests', url: 'https://github.com/example/api' } } })
    expect(configure.integrations).toEqual([])
    expect(configure.warnings).toEqual(['integrations.pulls.type: pullRequests needs a section or a project, whose folder the agents work in.'])
  })
})

describe('pull requests and issues', () => {
  /**
   * Reads a section declaring integrations.
   * @param integrations - The raw integrations of the section.
   * @param root - The other settings of the configuration.
   * @returns The configuration once read.
   */
  async function loadIntegrations (integrations: Record<string, unknown>, root: Record<string, unknown> = {}): Promise<DevtoolConfigure> {
    return loadApi({}, { integrations }, root)
  }

  it('reads the pull requests of a GitHub repository with the default settings', async () => {
    const configure = await loadIntegrations({ pulls: { name: 'Pulls', type: 'pullRequests', url: 'https://github.com/example/api.git' } })
    expect(configure.warnings).toEqual([])
    expect(configure.projects.main.integrations).toEqual([{
      slug: 'pulls',
      name: 'Pulls',
      type: 'pullRequests',
      icon: 'lucide:git-pull-request',
      url: 'https://github.com/example/api',
      embed: false,
      provider: { name: 'github', label: 'GitHub' },
      agentActions: [],
      agentPrompts: { review: DEFAULT_AGENT_PROMPTS.review },
      badge: true,
      refresh: 5
    }])
    expect(configure.integrationTokens).toEqual({})
  })

  it('reads the issues of a GitLab repository from an SSH remote with the actions of agents', async () => {
    const configure = await loadIntegrations({ issues: { name: 'Issues', type: 'issues', icon: 'mdi:bug', url: 'git@gitlab.com:example/api.git', agentAnalyze: true, agentFix: false, badge: false, refresh: 0 } })
    expect(configure.warnings).toEqual([])
    expect(configure.projects.main.integrations[0]).toMatchObject({
      type: 'issues',
      icon: 'mdi:bug',
      url: 'https://gitlab.com/example/api',
      provider: { name: 'gitlab', label: 'GitLab' },
      agentActions: ['analyze'],
      agentPrompts: { analyze: DEFAULT_AGENT_PROMPTS.analyze, fix: DEFAULT_AGENT_PROMPTS.fix },
      badge: false,
      refresh: 0
    })
  })

  it('uses the declared provider for a host it cannot guess', async () => {
    const configure = await loadIntegrations({ pulls: { name: 'Pulls', type: 'pullRequests', provider: 'gitlab', url: 'https://git.example.dev/team/api' } })
    expect(configure.warnings).toEqual([])
    expect(configure.projects.main.integrations[0]).toMatchObject({ url: 'https://git.example.dev/team/api', provider: { name: 'gitlab', label: 'GitLab' } })
  })

  it('takes the prompts of the integration over those of the devtool settings and the defaults', async () => {
    const configure = await loadIntegrations(
      { issues: { name: 'Issues', type: 'issues', url: 'https://github.com/example/api', agentPrompts: { fix: 'Fix %{ADT:ISSUE_URL}' } } },
      { adt: { agentPrompts: { issues: { analyze: 'Analyze %{ADT:ISSUE_URL}', fix: 'Ignored' }, pullRequests: { review: 'Review %{ADT:PR_URL}' } } } }
    )
    expect(configure.warnings).toEqual([])
    expect(configure.projects.main.integrations[0].agentPrompts).toEqual({ analyze: 'Analyze %{ADT:ISSUE_URL}', fix: 'Fix %{ADT:ISSUE_URL}' })
  })

  it('keeps the token and its automation by the key of the integration', async () => {
    const configure = await loadIntegrations({ pulls: { name: 'Pulls', type: 'pullRequests', url: 'https://github.com/example/api', token: '{{ $(gh auth token) }}' } })
    expect(configure.integrationTokens).toEqual({ 'main/pulls': '{{ $(gh auth token) }}' })
    expect(configure.automations[integrationAutomationKey('main/pulls')]).toEqual({ unless: null, opAccount: null, answers: [] })
  })

  it('keeps a plain token without automation', async () => {
    const configure = await loadIntegrations({ pulls: { name: 'Pulls', type: 'pullRequests', url: 'https://github.com/example/api', token: 'plain-token' } })
    expect(configure.integrationTokens).toEqual({ 'main/pulls': 'plain-token' })
    expect(configure.automations).toEqual({})
  })

  it('names the integrations of a project after their section and project', async () => {
    const configure = await loadApi({ integrations: { pulls: { name: 'Pulls', type: 'pullRequests', url: 'https://github.com/example/api', token: '{{ op://vault/github/token }}', opAccount: 'team.example.dev' } } })
    expect(configure.warnings).toEqual([])
    expect(apiOf(configure).integrations.map(integration => integration.slug)).toEqual(['pulls'])
    expect(configure.integrationTokens).toEqual({ 'main/api/pulls': '{{ op://vault/github/token }}' })
    expect(configure.automations[integrationAutomationKey('main/api/pulls')]).toEqual({ unless: null, opAccount: 'team.example.dev', answers: [] })
  })

  it('warns about a missing URL in a folder without origin remote', async () => {
    const configure = await loadIntegrations({ pulls: { name: 'Pulls', type: 'pullRequests' } })
    expect(configure.projects.main.integrations).toEqual([])
    expect(configure.warnings).toEqual([`projects[main].integrations.pulls.url: is missing and ${workspace} has no origin remote.`])
  })

  it('warns about invalid repositories, providers, refresh delays, flags and tokens', async () => {
    const pulls = { name: 'Pulls', type: 'pullRequests', url: 'https://github.com/example/api' }
    const configure = await loadIntegrations({
      repository: { ...pulls, url: 'https://github.com/example' },
      unknown: { ...pulls, url: 'https://git.example.dev/team/api' },
      provider: { ...pulls, provider: 'bitbucket' },
      refresh: { ...pulls, refresh: -1 },
      badge: { ...pulls, badge: 'yes' },
      review: { ...pulls, agentReview: 1 },
      token: { ...pulls, token: 5 }
    })
    expect(configure.projects.main.integrations).toEqual([])
    expect(configure.warnings).toEqual([
      'projects[main].integrations.repository.url: must name a repository.',
      'projects[main].integrations.unknown.provider: cannot be guessed from git.example.dev, set one of github, gitlab.',
      'projects[main].integrations.provider.provider: must be one of github, gitlab.',
      'projects[main].integrations.refresh.refresh: must be a number of minutes, 0 to read on demand only.',
      'projects[main].integrations.badge.badge: must be true or false.',
      'projects[main].integrations.review.agentReview: must be true or false.',
      'projects[main].integrations.token.token: is not a string.'
    ])
  })

  it('warns about actions and prompts the kind does not offer, keeping the integration', async () => {
    const configure = await loadIntegrations({ pulls: { name: 'Pulls', type: 'pullRequests', url: 'https://github.com/example/api', agentReview: true, agentFix: true, agentPrompts: { fix: 'Fix' } } })
    expect(configure.projects.main.integrations[0].agentActions).toEqual(['review'])
    expect(configure.warnings).toEqual([
      'projects[main].integrations.pulls.agentFix: is not an action of pullRequests, which offer agentReview.',
      'projects[main].integrations.pulls.agentPrompts.fix: is not an action of pullRequests, which offer review.'
    ])
  })

  it('warns about prompts that are not a map', async () => {
    const configure = await loadIntegrations({ issues: { name: 'Issues', type: 'issues', url: 'https://github.com/example/api', agentPrompts: 'Fix' } })
    expect(configure.projects.main.integrations).toHaveLength(1)
    expect(configure.warnings).toEqual(['projects[main].integrations.issues.agentPrompts: must be a map of prompts by action.'])
  })
})

describe('sections', () => {
  it('reads a section and its directories', async () => {
    const configure = await loadApi({}, { description: 'Main section', meta: { team: 'core' } })
    expect(configure.warnings).toEqual([])
    expect(configure.projects.main).toMatchObject({
      slug: 'main',
      name: 'Main',
      description: 'Main section',
      path: workspace,
      notifications: true,
      missing: false,
      restore: null,
      integrations: [],
      icons: [],
      lines: [],
      sort: 'config',
      order: [],
      content: ['api'],
      meta: { team: 'core' },
      mcpTarget: { path: ['sections', 'main', 'mcp'], declaredIn: null }
    })
    expect(Object.keys(configure.projects.main.directories)).toEqual(['api'])
    expect(configure.getForClient('1.0.0').projects).toBe(configure.projects)
  })

  it('names a section after its slug and has no description by default', async () => {
    const configure = await load({ projects: { main: { path: workspace, directories: { api: directory('api') } } } })
    expect(configure.warnings).toEqual([])
    expect(configure.projects.main.name).toBe('main')
    expect(configure.projects.main.description).toBeNull()
  })

  it('warns about a name that is not a string and names the section after its slug', async () => {
    const configure = await load({ projects: { main: { name: 5, path: workspace, directories: { api: directory('api') } } } })
    expect(configure.warnings).toEqual(['projects[main].name: is not a string.'])
    expect(configure.projects.main.name).toBe('main')
  })

  it('warns about an invalid slug', async () => {
    const configure = await load({ projects: { 'bad section': { name: 'Bad', path: workspace, directories: { api: directory('api') } } } })
    expect(configure.projects).toEqual({})
    expect(configure.warnings).toEqual(['projects[bad section]: is not a slug (a-z0-9-/_.).'])
  })

  it('warns about a missing or relative path', async () => {
    const configure = await load({ projects: { none: { name: 'None', directories: {} }, relative: { name: 'Relative', path: 'api', directories: {} } } })
    expect(configure.projects).toEqual({})
    expect(configure.warnings).toEqual([
      'projects[none].path: is not a string.',
      'projects[relative].path: is relative to the workspace, which is not declared (workspace: <folder>).'
    ])
  })

  it('warns about a folder that does not exist or is a file', async () => {
    const file = await writeFile('file.txt', 'text')
    const configure = await load({
      projects: {
        ghost: { name: 'Ghost', path: path.join(workspace, 'ghost'), directories: { api: directory('api') } },
        file: { name: 'File', path: file, directories: { api: directory('api') } }
      }
    })
    expect(configure.projects).toEqual({})
    expect(hasWarning(configure, /^projects\[ghost\]\.path: ENOENT/)).toBe(true)
    expect(configure.warnings).toContain('projects[file].path: not a directory.')
  })

  it('keeps a missing section declaring how to restore it', async () => {
    const missing = path.join(workspace, 'missing')
    const configure = await load({ projects: { main: { name: 'Main', path: missing, restore: { name: 'Clone', args: ['git', 'clone', 'git@github.com:example/api.git', '%{ADT:PATH}'] }, directories: { api: directory('api') } } } })
    expect(configure.warnings).toEqual([])
    expect(configure.projects.main).toMatchObject({
      path: missing,
      missing: true,
      directories: {},
      restore: { name: 'Clone', args: ['git', 'clone', 'git@github.com:example/api.git', '%{ADT:PATH}'] }
    })
  })

  it('names the restore command Restore by default and warns about invalid arguments', async () => {
    const missing = path.join(workspace, 'missing')
    const restored = await load({ projects: { main: { name: 'Main', path: missing, restore: { args: ['git', 'clone'] }, directories: {} } } })
    expect(restored.projects.main.restore).toEqual({ name: 'Restore', args: ['git', 'clone'] })
    const configure = await loadApi({}, { restore: { args: 'git clone' } })
    expect(configure.projects.main.restore).toBeNull()
    expect(configure.warnings).toEqual(['projects[main].restore.args: must be a non-empty array of strings or numbers.'])
  })

  it('warns about a section without directories', async () => {
    const configure = await load(sectionConfig({}))
    expect(configure.projects).toEqual({})
    expect(configure.warnings).toEqual(['projects[main].directories: is empty.'])
  })

  it('warns about a section without valid directories', async () => {
    const configure = await load(sectionConfig({ 'bad dir': directory('api') }))
    expect(configure.projects).toEqual({})
    expect(configure.warnings).toEqual(['projects[main].directories[bad dir]: is not a slug (a-z0-9-/_.).', 'projects[main].directories: contains no valid entries.'])
  })

  it('passes its notifications to its directories, which may turn them back on', async () => {
    const configure = await load(sectionConfig({ api: directory('api'), web: directory('web', { notifications: true }) }, { notifications: false }))
    expect(configure.projects.main.notifications).toBe(false)
    expect(configure.projects.main.directories.api.notifications).toBe(false)
    expect(configure.projects.main.directories.web.notifications).toBe(true)
  })

  it('passes the notifications of the devtool to its sections', async () => {
    const configure = await loadApi({}, {}, { adt: { notifications: false } })
    expect(configure.projects.main.notifications).toBe(false)
    expect(apiOf(configure).notifications).toBe(false)
  })
})

describe('section content', () => {
  /**
   * Reads the section `main` holding `api` and `web` and showing the integration `docs` as a line.
   * @param section - The other settings of the section.
   * @param root - The other settings of the configuration.
   * @returns The configuration once read.
   */
  async function loadContent (section: Record<string, unknown> = {}, root: Record<string, unknown> = {}): Promise<DevtoolConfigure> {
    return load(sectionConfig(
      { api: directory('api'), web: directory('web') },
      { integrations: { docs: { name: 'Docs', url: 'https://docs.example.dev' } }, lines: ['integration:docs'], ...section },
      root
    ))
  }

  it('lists its lines first, then its directories, in the order of the configuration', async () => {
    const configure = await loadContent()
    expect(configure.warnings).toEqual([])
    expect(configure.projects.main.lines).toEqual([{ type: 'integration', slug: 'docs', index: 0 }])
    expect(configure.projects.main.content).toEqual(['integration:docs', 'api', 'web'])
  })

  it('orders its content by name', async () => {
    expect((await loadContent({ sort: 'name' })).projects.main.content).toEqual(['api', 'integration:docs', 'web'])
  })

  it('orders its content as the sidebar by default', async () => {
    expect((await loadContent({}, { adt: { sidebar: { sort: 'name' } } })).projects.main.sort).toBe('name')
  })

  it('orders its content by hand, warning about keys naming nothing', async () => {
    const configure = await loadContent({ sort: 'manual', order: ['web', 'ghost', 'integration:docs'] })
    expect(configure.projects.main.content).toEqual(['web', 'integration:docs', 'api'])
    expect(configure.warnings).toEqual(['projects[main].order: ghost names nothing here.'])
  })

  it('warns about an invalid sort or order', async () => {
    const configure = await loadContent({ sort: 'random', order: 'web' })
    expect(configure.projects.main).toMatchObject({ sort: 'config', order: [] })
    expect(configure.warnings).toEqual(['projects[main].sort: must be config, name, manual.', 'projects[main].order: must be a list.'])
  })

  it('shows its own integrations only in its header', async () => {
    const configure = await loadContent({ icons: ['integration:docs', 'command:dev', 'integration:ghost', 5], lines: 'integration:docs' })
    expect(configure.projects.main.icons).toEqual([{ type: 'integration', slug: 'docs', index: 0 }])
    expect(configure.projects.main.lines).toEqual([])
    expect(configure.warnings).toEqual([
      'projects[main].icons[1]: command:dev names no integration of the section.',
      'projects[main].icons[2]: integration:ghost names no integration of the section.',
      'projects[main].icons[3]: must be <type>:<slug>.',
      'projects[main].lines: must be a list of <type>:<slug>.'
    ])
  })
})

describe('directories', () => {
  it('reads a directory with its defaults', async () => {
    const configure = await loadApi({ meta: { port: 3000 } })
    expect(configure.warnings).toEqual([])
    expect(apiOf(configure)).toMatchObject({
      slug: 'api',
      name: 'API',
      description: null,
      path: path.join(workspace, 'api'),
      loadBalancer: {},
      args: null,
      extras: {},
      scripts: [],
      files: {},
      defaultAction: null,
      integrations: [],
      icons: [],
      lines: [],
      notifications: true,
      env: {},
      shell: null,
      killSignal: null,
      missing: false,
      restore: null,
      mcpTarget: { path: ['projects', 'api', 'mcp'], declaredIn: null },
      meta: { port: 3000 }
    })
  })

  it('warns about a project naming no section', async () => {
    const configure = await loadApi({ section: 'missing' })
    expect(configure.warnings).toEqual([`${API}.section: names no section, the project is under main.`])
    expect(apiOf(configure).slug).toBe('api')
  })

  it('gives keys to the files of a project whose slug holds dots', async () => {
    await fs.mkdir(path.join(workspace, 'my.app'))
    const configure = await load(sectionConfig({ 'my.app': directory('my.app', { files: { docs: { path: 'docs', mcp: { read: 'keys' } } } }) }))
    expect(configure.warnings).toEqual([])
    expect(configure.projects.main.directories['my.app'].files.docs.mcp.read).toEqual({ level: 'keys', from: 'projects.my.app.files.docs' })
  })

  it('reads its description, absolute path, arguments, environment, shell and kill signal', async () => {
    const web = path.join(workspace, 'web')
    const configure = await loadApi({ description: 'The API', path: web, args: ['pnpm', 'dev', 3000], env: { PORT: '3000' }, shell: '/bin/bash', killSignal: 'sigint' })
    expect(configure.warnings).toEqual([])
    expect(apiOf(configure)).toMatchObject({ description: 'The API', path: web, args: ['pnpm', 'dev', '3000'], env: { PORT: '3000' }, shell: '/bin/bash', killSignal: 'SIGINT' })
  })

  it('inherits the shell of the devtool', async () => {
    expect(apiOf(await loadApi({}, {}, { adt: { shell: '/bin/zsh' } })).shell).toBe('/bin/zsh')
  })

  it('reads the kill signal written in lowercase', async () => {
    expect(apiOf(await loadApi({ killsignal: 'SIGTERM' })).killSignal).toBe('SIGTERM')
  })

  it('ignores an environment holding other values than texts', async () => {
    const configure = await loadApi({ env: { PORT: 3000 } })
    expect(apiOf(configure).env).toEqual({})
    expect(configure.warnings).toEqual([])
  })

  it('warns about invalid kill signals and shells', async () => {
    const configure = await load(sectionConfig({ api: directory('api', { killSignal: 'TERM' }), web: directory('web', { killSignal: 9, shell: 5 }) }))
    expect(apiOf(configure).killSignal).toBeNull()
    expect(configure.warnings).toEqual([
      `${API}.killSignal: must match SIG* format (example: SIGTERM, SIGKILL).`,
      'projects[main].directories[web].shell: is not a string.',
      'projects[main].directories[web].killSignal: is not a string.'
    ])
  })

  it('drops a directory whose arguments are not a list', async () => {
    const configure = await load(sectionConfig({ api: directory('api', { args: 'pnpm dev' }), web: directory('web') }))
    expect(Object.keys(configure.projects.main.directories)).toEqual(['web'])
    expect(configure.warnings).toEqual([`${API}.args: must be an array of strings, numbers or inputs.`])
  })

  it('warns about a folder that does not exist', async () => {
    const configure = await load(sectionConfig({ api: directory('api'), ghost: directory('ghost') }))
    expect(Object.keys(configure.projects.main.directories)).toEqual(['api'])
    expect(hasWarning(configure, /^projects\[main\]\.directories\[ghost\]\.path: ENOENT/)).toBe(true)
  })

  it('keeps a missing directory declaring how to restore it', async () => {
    const configure = await load(sectionConfig({ ghost: directory('ghost', { restore: { name: 'Clone', args: ['git', 'clone'] } }) }))
    expect(configure.warnings).toEqual([])
    expect(configure.projects.main.directories.ghost).toMatchObject({ path: path.join(workspace, 'ghost'), missing: true, restore: { name: 'Clone', args: ['git', 'clone'] } })
  })

  it('names a directory after its slug', async () => {
    const configure = await load(sectionConfig({ api: { path: 'api' } }))
    expect(configure.warnings).toEqual([])
    expect(apiOf(configure).name).toBe('api')
  })

  it('finds a directory in the folder named after its slug', async () => {
    const configure = await load(sectionConfig({ api: {} }))
    expect(configure.warnings).toEqual([])
    expect(apiOf(configure)).toMatchObject({ name: 'api', path: path.join(workspace, 'api') })
  })

  it('warns about a name or path that is not a string and falls back to its slug', async () => {
    const configure = await load(sectionConfig({ api: { name: 5, path: ['web'] } }))
    expect(configure.warnings).toEqual([
      'projects[main].directories[api].name: is not a string.',
      'projects[main].directories[api].path: is not a string.'
    ])
    expect(apiOf(configure)).toMatchObject({ name: 'api', path: path.join(workspace, 'api') })
  })
})

describe('commands', () => {
  it('reads a command with its settings', async () => {
    const configure = await loadApi({
      shell: '/bin/zsh',
      extras: {
        dev: { name: 'Dev', args: ['pnpm', 'dev'], detached: true, prompt: true, startWithSection: true, form: 'inline', env: { PORT: '3000' }, shell: '/bin/bash', killSignal: 'sigkill', notifications: false, meta: { tag: 'dev' } },
        build: { name: 'Build', args: ['pnpm', 'build'] }
      }
    })
    expect(configure.warnings).toEqual([])
    const { extras } = apiOf(configure)
    expect(extras.dev).toMatchObject({
      slug: 'dev',
      name: 'Dev',
      args: ['pnpm', 'dev'],
      detached: true,
      prompt: true,
      form: 'inline',
      automated: false,
      startWithSection: true,
      notifications: false,
      env: { PORT: '3000' },
      shell: '/bin/bash',
      killSignal: 'SIGKILL',
      script: null,
      mcpTarget: { path: ['projects', 'api', 'commands', 'dev', 'mcp'], declaredIn: null },
      meta: { tag: 'dev' }
    })
    expect(extras.build).toMatchObject({ detached: false, prompt: false, form: 'dialog', startWithSection: false, notifications: true, env: {}, shell: '/bin/zsh', killSignal: null })
  })

  it('gives a command the environment of its project under its own', async () => {
    const configure = await loadApi({
      env: [{ STAGE: 'dev' }, { PORT: '3000' }],
      extras: {
        dev: { args: ['pnpm', 'dev'], env: { PORT: '4000', DEBUG: '1' } },
        build: { args: ['pnpm', 'build'] }
      }
    })
    expect(configure.warnings).toEqual([])
    const { extras } = apiOf(configure)
    expect(extras.dev.env).toEqual({ STAGE: 'dev', PORT: '4000', DEBUG: '1' })
    expect(extras.build.env).toEqual({ STAGE: 'dev', PORT: '3000' })
  })

  it('names a command after its slug', async () => {
    const configure = await loadApi({ extras: { dev: { args: ['pnpm', 'dev'] } } })
    expect(configure.warnings).toEqual([])
    expect(apiOf(configure).extras.dev.name).toBe('dev')
  })

  it('warns about a name that is not a string and names the command after its slug', async () => {
    const configure = await loadApi({ extras: { dev: { name: false, args: ['pnpm', 'dev'] } } })
    expect(configure.warnings).toEqual(['projects[main].directories[api].extras[dev].name: is not a string.'])
    expect(apiOf(configure).extras.dev.name).toBe('dev')
  })

  it('warns about the old default command, invalid arguments and forms', async () => {
    const configure = await loadApi({
      extras: {
        default: { name: 'Default', args: ['x'] },
        broken: { name: 'Broken' },
        form: { name: 'Form', args: ['x'], form: 'popup' }
      }
    })
    const { extras } = apiOf(configure)
    expect(Object.keys(extras)).toEqual(['form'])
    expect(extras.form.form).toBe('dialog')
    expect(configure.warnings).toEqual([
      `${API}.commands.default: is replaced by default: { action: command:<slug> }.`,
      `${API}.extras[broken].args: must be an array of strings, numbers or inputs.`,
      `${API}.extras[form].form: must be dialog or inline.`
    ])
  })

  it('keeps what the server does around a command', async () => {
    const configure = await loadApi({
      extras: {
        login: {
          name: 'Login',
          opAccount: 'team.example.dev',
          unless: ['my-cli', 'status', 1],
          args: ['my-cli', 'login', '{{ op://vault/item/username }}'],
          env: { API_KEY: '{{ file://.env#/API_KEY }}' },
          answers: [{ match: 'Enter password', value: '{{ op://vault/item/password }}' }]
        }
      }
    })
    expect(configure.warnings).toEqual([])
    expect(apiOf(configure).extras.login.automated).toBe(true)
    expect(configure.automations['main/api/login']).toEqual({
      unless: ['my-cli', 'status', '1'],
      opAccount: 'team.example.dev',
      answers: [{ pattern: /Enter password/i, value: '{{ op://vault/item/password }}' }]
    })
  })

  it('automates a command whose environment reads a value block', async () => {
    const configure = await loadApi({ extras: { dev: { name: 'Dev', args: ['pnpm', 'dev'], env: { TOKEN: '{{ $(gh auth token) }}' } } } })
    expect(apiOf(configure).extras.dev.automated).toBe(true)
    expect(configure.automations['main/api/dev']).toEqual({ unless: null, opAccount: null, answers: [] })
  })

  it('warns about unknown value blocks, invalid checks and answers', async () => {
    const configure = await loadApi({
      extras: {
        login: {
          name: 'Login',
          args: ['my-cli', '{{ secret }}'],
          env: { TOKEN: '{{ vault }}' },
          unless: 'my-cli status',
          answers: [{ match: 'OTP' }, { match: '(', value: 'x' }, { match: 'Name', value: '{{ name }}' }]
        }
      }
    })
    expect(configure.automations['main/api/login']).toEqual({ unless: null, opAccount: null, answers: [{ pattern: /Name/i, value: '{{ name }}' }] })
    expect(configure.warnings).toEqual([
      `${API}.extras[login].args[1]: unknown value block {{ secret }}, expected {{ op://… }}, {{ file://… }} or {{ $(…) }}.`,
      `${API}.extras[login].env.TOKEN: unknown value block {{ vault }}, expected {{ op://… }}, {{ file://… }} or {{ $(…) }}.`,
      `${API}.extras[login].answers[2].value: unknown value block {{ name }}, expected {{ op://… }}, {{ file://… }} or {{ $(…) }}.`,
      `${API}.extras[login].unless: must be an array of strings or numbers.`,
      `${API}.extras[login].answers[0]: must be { match, value }.`,
      `${API}.extras[login].answers[1].match: is not a valid regular expression.`
    ])
  })
})

describe('command inputs', () => {
  /**
   * Reads the arguments of the command `run` of the directory `api`.
   * @param args - The raw arguments.
   * @returns The configuration once read.
   */
  async function loadArgs (args: unknown[]): Promise<DevtoolConfigure> {
    return loadApi({ extras: { run: { name: 'Run', args } } })
  }

  it('reads choices, flags and texts with their defaults', async () => {
    const configure = await loadArgs([
      'deploy',
      { name: 'env', choices: ['prd', { label: 'Pre-production', value: 'pre' }, 3], default: 'pre', display: 'dropdown', optional: true },
      { name: 'replicas', choices: [1, 2], default: 2 },
      { name: '--headed', flag: true, default: true },
      { name: 'message', text: true, default: 'release' }
    ])
    expect(configure.warnings).toEqual([])
    expect(apiOf(configure).extras.run.args).toEqual([
      'deploy',
      { name: 'env', kind: 'choice', choices: [{ label: 'prd', value: 'prd' }, { label: 'Pre-production', value: 'pre' }, { label: '3', value: '3' }], display: 'dropdown', optional: true, default: 'pre' },
      { name: 'replicas', kind: 'choice', choices: [{ label: '1', value: '1' }, { label: '2', value: '2' }], display: 'buttons', optional: false, default: '2' },
      { name: '--headed', kind: 'flag', choices: [], display: 'buttons', optional: true, default: true },
      { name: 'message', kind: 'text', choices: [], display: 'buttons', optional: true, default: 'release' }
    ])
  })

  it('warns about inputs without name, kind, valid choices or display', async () => {
    const configure = await loadArgs([
      { choices: ['a'] },
      { name: 'env', choices: [{ label: 'Production' }, 'prd'], display: 'list' },
      { name: 'empty' }
    ])
    expect(apiOf(configure).extras.run.args).toEqual([
      { name: 'env', kind: 'choice', choices: [{ label: 'prd', value: 'prd' }], display: 'buttons', optional: false, default: null }
    ])
    expect(configure.warnings).toEqual([
      `${API}.extras[run].args[0].name: is not a string.`,
      `${API}.extras[run].args[1].choices[0]: must be a value or { label, value }.`,
      `${API}.extras[run].args[1].display: must be buttons or dropdown.`,
      `${API}.extras[run].args[2]: must be a string, a number, or an input with choices, flag: true or text: true.`
    ])
  })

  it('warns about defaults that do not fit their input', async () => {
    const configure = await loadArgs([
      { name: 'env', choices: ['prd'], default: 'dev' },
      { name: '--headed', flag: true, default: 'yes' },
      { name: 'message', text: true, default: false }
    ])
    expect(apiOf(configure).extras.run.args.map(arg => (typeof arg === 'string' ? arg : arg.default))).toEqual([null, null, null])
    expect(configure.warnings).toEqual([
      `${API}.extras[run].args[0].default: must be one of the choices.`,
      `${API}.extras[run].args[1].default: must be a boolean.`,
      `${API}.extras[run].args[2].default: must be a string.`
    ])
  })
})

describe('services', () => {
  /**
   * Reads the service `web` of the directory `api`.
   * @param service - The raw service.
   * @returns The configuration once read.
   */
  async function loadService (service: Record<string, unknown>): Promise<DevtoolConfigure> {
    return loadApi({ loadBalancer: { web: service } })
  }

  it('reads a service with all its settings', async () => {
    const configure = await loadService({ host: 'web.example.dev', target: 5173, tls: true, path: '/app', prefix: '/p', pathNot: '/api', preserveHost: true, access: 'network' })
    expect(configure.warnings).toEqual([])
    expect(apiOf(configure).loadBalancer.web).toEqual({
      slug: 'web',
      hosts: ['web.example.dev'],
      targets: ['http://127.0.0.1:5173/'],
      tls: true,
      path: '/app',
      prefix: '/p',
      pathNot: '/api',
      preserveHost: true,
      access: 'network'
    })
  })

  it('reads a service with its defaults and several hosts', async () => {
    const configure = await loadService({ hosts: ['web.example.dev', 'www.example.dev'], host: 'ignored.example.dev', target: 'localhost:3000' })
    expect(configure.warnings).toEqual([])
    expect(apiOf(configure).loadBalancer.web).toEqual({
      slug: 'web',
      hosts: ['web.example.dev', 'www.example.dev'],
      targets: ['http://localhost:3000/'],
      tls: false,
      path: null,
      prefix: null,
      pathNot: null,
      preserveHost: false,
      access: 'local'
    })
  })

  it.each<[string, unknown, string[]]>([
    ['a port', 5173, ['http://127.0.0.1:5173/']],
    ['a port written as text', ' 5173 ', ['http://127.0.0.1:5173/']],
    ['the highest port', 65535, ['http://127.0.0.1:65535/']],
    ['a host and port', '192.168.1.20:8080', ['http://192.168.1.20:8080/']],
    ['an IPv6 host and port', '[::1]:8080', ['http://[::1]:8080/']],
    ['a host and port with spaces', '  localhost:3000  ', ['http://localhost:3000/']],
    ['an https URL', 'https://192.168.1.20:8443/base', ['https://192.168.1.20:8443/base']],
    ['an http URL without port', 'http://api.example.dev', ['http://api.example.dev/']],
    ['a list', [5173, 'localhost:5174', 'https://api.example.dev'], ['http://127.0.0.1:5173/', 'http://localhost:5174/', 'https://api.example.dev/']]
  ])('reads a target given as %s', async (_label, target, targets) => {
    const configure = await loadService({ host: 'web.example.dev', target })
    expect(configure.warnings).toEqual([])
    expect(apiOf(configure).loadBalancer.web.targets).toEqual(targets)
  })

  it.each<[string, unknown, string]>([
    ['a host without port', 'localhost', 'localhost is not a port, <host>:<port> or http(s) URL'],
    ['another scheme', 'ftp://files.example.dev', 'ftp://files.example.dev is not a port, <host>:<port> or http(s) URL'],
    ['a port out of range', 70000, '70000 is not a port, <host>:<port> or http(s) URL'],
    ['port 0', 0, '0 is not a port, <host>:<port> or http(s) URL'],
    ['port 0 written as text', '0', '0 is not a port, <host>:<port> or http(s) URL'],
    ['a port written as text out of range', '70000', '70000 is not a port, <host>:<port> or http(s) URL'],
    ['a negative port', -1, '-1 is not a port, <host>:<port> or http(s) URL'],
    ['a decimal port', 5173.5, '5173.5 is not a port, <host>:<port> or http(s) URL'],
    ['a host and port 0', 'localhost:0', 'localhost:0 is not a port, <host>:<port> or http(s) URL'],
    ['a host and port out of range', 'localhost:65536', 'localhost:65536 is not a port, <host>:<port> or http(s) URL'],
    ['a URL with port 0', 'http://localhost:0/app', 'http://localhost:0/app is not a port, <host>:<port> or http(s) URL'],
    ['a URL with a port out of range', 'https://localhost:65536', 'https://localhost:65536 is not a port, <host>:<port> or http(s) URL'],
    ['a list holding an invalid entry', [5173, 'nope'], 'nope is not a port, <host>:<port> or http(s) URL'],
    ['an empty list', [], 'must be <port> | <host>:<port> | <URL>, or a list of them'],
    ['nothing', undefined, 'must be <port> | <host>:<port> | <URL>, or a list of them']
  ])('refuses a target given as %s', async (_label, target, message) => {
    const configure = await loadService({ host: 'web.example.dev', target })
    expect(apiOf(configure).loadBalancer).toEqual({})
    expect(configure.warnings).toEqual([`${SERVICE}.target: ${message}.`])
  })

  it('warns about missing or invalid hosts', async () => {
    for (const service of [{ target: 5173 }, { hosts: [], target: 5173 }, { hosts: ['web.example.dev', 1], target: 5173 }]) {
      const configure = await loadService(service)
      expect(apiOf(configure).loadBalancer).toEqual({})
      expect(configure.warnings).toEqual([`${SERVICE}.host: must be a host name or a list of host names.`])
    }
  })

  it('warns about the old target keys', async () => {
    const configure = await loadService({ host: 'web.example.dev', ports: [5173], urls: ['http://localhost:5173'], url: 'http://localhost:5173', target: 5173 })
    expect(apiOf(configure).loadBalancer.web.targets).toEqual(['http://127.0.0.1:5173/'])
    expect(configure.warnings).toEqual([
      `${SERVICE}.ports: is replaced by target: <port> | <host>:<port> | <URL>, or a list of them.`,
      `${SERVICE}.urls: is replaced by target: <port> | <host>:<port> | <URL>, or a list of them.`,
      `${SERVICE}.url: is replaced by target: <port> | <host>:<port> | <URL>, or a list of them.`
    ])
  })

  it.each<[string, Record<string, unknown>, string]>([
    ['tls', { tls: 'yes' }, 'tls: is not a boolean'],
    ['path', { path: 5 }, 'path: is not a string'],
    ['prefix', { prefix: 5 }, 'prefix: is not a string'],
    ['pathNot', { pathNot: 5 }, 'pathNot: is not a string'],
    ['preserveHost', { preserveHost: 'yes' }, 'preserveHost: is not a boolean']
  ])('refuses a service with an invalid %s', async (_label, settings, message) => {
    const configure = await loadService({ host: 'web.example.dev', target: 5173, ...settings })
    expect(apiOf(configure).loadBalancer).toEqual({})
    expect(configure.warnings).toEqual([`${SERVICE}.${message}.`])
  })

  it('warns about an invalid access and keeps the service local', async () => {
    const configure = await loadService({ host: 'web.example.dev', target: 5173, access: 'public' })
    expect(apiOf(configure).loadBalancer.web.access).toBe('local')
    expect(configure.warnings).toEqual([`${SERVICE}.access: must be local or network, local is used.`])
  })
})

describe('scripts', () => {
  /**
   * Writes the scripts folder of the directory `api`: an executable script with a heading comment,
   * a text file and a hidden executable.
   * @returns The absolute path of the folder.
   */
  async function writeScripts (): Promise<string> {
    await writeFile('api/scripts/deploy.sh', '#!/bin/sh\n# Deploys the app.\n# Usage: deploy.sh <env>\n#   env: prd or pre\necho deploy\n', 0o755)
    await writeFile('api/scripts/notes.txt', 'notes\n')
    await writeFile('api/scripts/.hidden.sh', '#!/bin/sh\n', 0o755)
    return path.join(workspace, 'api', 'scripts')
  }

  it('offers the executables of a folder as commands', async () => {
    const folder = await writeScripts()
    const configure = await loadApi({ scripts: ['scripts'], env: { STAGE: 'dev' } })
    expect(configure.warnings).toEqual([])
    const api = apiOf(configure)
    expect(api.scripts).toEqual([{
      path: folder,
      prompt: false,
      form: 'inline',
      only: null,
      scripts: {},
      mcp: configure.adt.mcp.scripts,
      mcpTarget: { path: ['projects', 'api', 'scripts', '0', 'mcp'], declaredIn: null }
    }])
    expect(Object.keys(api.extras)).toEqual(['scripts/deploy.sh'])
    expect(api.extras['scripts/deploy.sh']).toMatchObject({
      slug: 'scripts/deploy.sh',
      name: 'deploy.sh',
      args: ['./scripts/deploy.sh', FREE_ARGUMENTS],
      form: 'inline',
      prompt: false,
      env: { STAGE: 'dev' },
      script: { summary: 'Deploys the app.', usage: 'deploy.sh <env>\n  env: prd or pre' },
      mcpTarget: { path: ['projects', 'api', 'scripts', '0', 'scripts', 'deploy.sh', 'mcp'], declaredIn: null }
    })
  })

  it('reads the settings of a folder and of its scripts', async () => {
    await writeScripts()
    const configure = await loadApi({
      scripts: [{
        path: 'scripts',
        prompt: true,
        form: 'dialog',
        only: ['*.sh'],
        mcp: 'deny',
        scripts: { 'deploy.sh': { prompt: false, form: 'inline', args: [{ name: 'env', choices: ['prd', 'pre'] }], mcp: { run: 'allow' } } }
      }]
    })
    expect(configure.warnings).toEqual([])
    const api = apiOf(configure)
    expect(api.scripts[0]).toMatchObject({ prompt: true, form: 'dialog', only: ['*.sh'], mcp: rulesOf('deny', 'projects.api.scripts.0') })
    expect(api.extras['scripts/deploy.sh']).toMatchObject({
      prompt: false,
      form: 'inline',
      args: ['./scripts/deploy.sh', { name: 'env', kind: 'choice', choices: [{ label: 'prd', value: 'prd' }, { label: 'pre', value: 'pre' }], display: 'buttons', optional: false, default: null }],
      mcp: { ...rulesOf('deny', 'projects.api.scripts.0'), run: { level: 'allow', from: 'projects.api.scripts.0.scripts.deploy.sh' } },
      mcpTarget: { path: ['projects', 'api', 'scripts', '0', 'scripts', 'deploy.sh', 'mcp'], declaredIn: null }
    })
  })

  it('keeps the files matching the patterns of the folder only', async () => {
    await writeScripts()
    expect(apiOf(await loadApi({ scripts: [{ path: 'scripts', only: ['*.py'] }] })).extras).toEqual({})
  })

  it('makes a script the main command named by the default action', async () => {
    await writeScripts()
    const configure = await loadApi({ scripts: ['scripts'], default: { action: 'command:scripts/deploy.sh' } })
    expect(configure.warnings).toEqual([])
    expect(apiOf(configure).args).toEqual(['./scripts/deploy.sh', FREE_ARGUMENTS])
  })

  it('hides a script behind the command of the same slug', async () => {
    await writeScripts()
    const configure = await loadApi({ scripts: ['scripts'], extras: { 'scripts/deploy.sh': { name: 'Deploy', args: ['echo'] } } })
    expect(apiOf(configure).extras['scripts/deploy.sh'].name).toBe('Deploy')
    expect(configure.warnings).toEqual([`${API}.scripts: scripts/deploy.sh is hidden by the command of the same slug.`])
  })

  it('warns about invalid folders', async () => {
    await writeScripts()
    const configure = await loadApi({
      scripts: [
        {},
        'ghost',
        { path: 'scripts', only: '*.sh', form: 'popup', scripts: { 'deploy.sh': { form: 'popup', args: 'x' } } }
      ]
    })
    const api = apiOf(configure)
    expect(api.scripts).toHaveLength(1)
    expect(api.scripts[0]).toMatchObject({ only: null, form: 'inline' })
    expect(configure.warnings[0]).toBe(`${API}.scripts[0].path: is not a string.`)
    expect(hasWarning(configure, /^projects\[main\]\.directories\[api\]\.scripts\[1\]: ENOENT/)).toBe(true)
    expect(configure.warnings.slice(2)).toEqual([
      `${API}.scripts[2].scripts[deploy.sh].args: must be an array of strings, numbers or inputs.`,
      `${API}.scripts[2].scripts[deploy.sh].form: must be dialog or inline.`,
      `${API}.scripts[2].only: must be an array of glob patterns.`,
      `${API}.scripts[2].form: must be dialog or inline.`
    ])
  })

  it('warns about folders that are not a list', async () => {
    const configure = await loadApi({ scripts: 'scripts' })
    expect(apiOf(configure).scripts).toEqual([])
    expect(configure.warnings).toEqual([`${API}.scripts: must be an array.`])
  })
})

describe('files', () => {
  it('reads folders of files and agent skills', async () => {
    const configure = await loadApi({
      extras: { pull: { name: 'Pull', args: ['git', 'pull'] } },
      files: {
        data: { name: 'Data', path: 'data', commands: ['pull'], restore: 'pull' },
        skills: { path: '.claude/skills', type: 'agentSkills' },
        home: { path: '/opt/shared', type: 'files' }
      }
    })
    expect(configure.warnings).toEqual([])
    const { files } = apiOf(configure)
    expect(files.data).toEqual({
      slug: 'data',
      name: 'Data',
      type: 'files',
      path: path.join(workspace, 'api', 'data'),
      restore: 'pull',
      commands: ['pull'],
      mcp: configure.adt.mcp.files,
      mcpTarget: { path: ['projects', 'api', 'files', 'data', 'mcp'], declaredIn: null }
    })
    expect(files.skills).toMatchObject({ name: 'skills', type: 'agentSkills', path: path.join(workspace, 'api', '.claude/skills'), restore: null, commands: [] })
    expect(files.home.path).toBe('/opt/shared')
  })

  it('accepts the keys level for a folder of files', async () => {
    const configure = await loadApi({ files: { data: { path: 'data', mcp: 'keys' } } })
    expect(configure.warnings).toEqual([])
    expect(apiOf(configure).files.data.mcp.read).toEqual({ level: 'keys', from: 'projects.api.files.data' })
  })

  it('warns about the old default folder, invalid slugs, paths and types', async () => {
    const configure = await loadApi({
      files: {
        'default': { path: 'data' },
        'bad slug': { path: 'data' },
        'nopath': { name: 'No path' },
        'docs': { path: 'docs', type: 'docs' }
      }
    })
    expect(apiOf(configure).files).toEqual({})
    expect(configure.warnings).toEqual([
      `${API}.files.default: is replaced by default: { action: files:<slug> }.`,
      `${API}.files[bad slug]: is not a slug (a-z0-9-/_.).`,
      `${API}.files[nopath].path: is not a string.`,
      `${API}.files[docs].type: must be files or agentSkills.`
    ])
  })

  it('warns about unknown commands and restore commands, keeping the folder', async () => {
    const configure = await loadApi({ extras: { pull: { name: 'Pull', args: ['git', 'pull'] } }, files: { data: { path: 'data', commands: ['pull', 'ghost'], restore: 'ghost' } } })
    expect(apiOf(configure).files.data).toMatchObject({ commands: ['pull'], restore: null })
    expect(configure.warnings).toEqual([
      `${API}.files[data].commands: unknown commands ghost.`,
      `${API}.files[data].restore: must name a command of the directory.`
    ])
  })
})

describe('default action', () => {
  const settings = {
    extras: { dev: { name: 'Dev', args: ['pnpm', 'dev'] } },
    files: { data: { path: 'data' } },
    loadBalancer: { web: { hosts: ['web.example.dev', 'www.example.dev'], target: 5173 } },
    integrations: { mail: { name: 'Mail', icon: 'mdi:email', url: 'https://mail.example.dev' } }
  }

  it('makes the command it names the main command', async () => {
    const configure = await loadApi({ ...settings, args: ['ignored'], default: { action: 'command:dev' } })
    expect(configure.warnings).toEqual([])
    const api = apiOf(configure)
    expect(api.defaultAction).toEqual({ shortcut: { type: 'command', slug: 'dev', index: 0 }, trigger: 'icon', icon: null })
    expect(api.args).toEqual(['pnpm', 'dev'])
  })

  it.each<[string, Record<string, unknown>, unknown]>([
    ['files', { action: 'files:data', trigger: 'row', icon: 'mdi:folder' }, { shortcut: { type: 'files', slug: 'data', index: 0 }, trigger: 'row', icon: 'mdi:folder' }],
    ['a host of a service', { action: 'service:web:1', trigger: 'row-icon' }, { shortcut: { type: 'service', slug: 'web', index: 1 }, trigger: 'row-icon', icon: null }],
    ['an integration', { action: 'integration:mail', icon: 'own' }, { shortcut: { type: 'integration', slug: 'mail', index: 0 }, trigger: 'icon', icon: 'own' }]
  ])('names %s', async (_label, action, expected) => {
    const configure = await loadApi({ ...settings, default: action })
    expect(configure.warnings).toEqual([])
    expect(apiOf(configure).defaultAction).toEqual(expected)
    expect(apiOf(configure).args).toBeNull()
  })

  it.each<[string, Record<string, unknown>, string]>([
    ['an unknown command', { action: 'command:ghost' }, 'default.action: command:ghost names no integration, command, files or service host of the directory'],
    ['a missing host of a service', { action: 'service:web:2' }, 'default.action: service:web:2 names no integration, command, files or service host of the directory'],
    ['an unknown type', { action: 'page:home' }, 'default.action: page:home names no integration, command, files or service host of the directory'],
    ['an action that is not a text', { action: 5 }, 'default.action: must be <type>:<slug>'],
    ['no action', { trigger: 'row' }, 'default.action: must be <type>:<slug>'],
    ['an unknown trigger', { action: 'command:dev', trigger: 'hover' }, 'default.trigger: must be icon, row or row-icon'],
    ['an icon without prefix', { action: 'command:dev', icon: 'folder' }, 'default.icon: must be own or an Iconify name <prefix>:<name>'],
    ['an icon that is not a text', { action: 'command:dev', icon: 5 }, 'default.icon: must be own or an Iconify name <prefix>:<name>']
  ])('refuses %s', async (_label, action, message) => {
    const configure = await loadApi({ ...settings, default: action })
    expect(apiOf(configure).defaultAction).toBeNull()
    expect(configure.warnings).toEqual([`${API}.${message}.`])
  })

  it('leaves the main command empty when the command it names does not exist', async () => {
    expect(apiOf(await loadApi({ ...settings, default: { action: 'command:ghost' } })).args).toBeNull()
  })
})

describe('directory shortcuts', () => {
  const settings = {
    extras: { dev: { name: 'Dev', args: ['pnpm', 'dev'] } },
    files: { data: { path: 'data' } },
    loadBalancer: { web: { hosts: ['web.example.dev', 'www.example.dev'], target: 5173 } },
    integrations: { mail: { name: 'Mail', url: 'https://mail.example.dev' } }
  }

  it('reads icons and lines naming what the directory declares', async () => {
    const configure = await loadApi({ ...settings, icons: ['integration:mail', 'service:web', 'service:web:1'], lines: ['command:dev', 'files:data'] })
    expect(configure.warnings).toEqual([])
    expect(apiOf(configure).icons).toEqual([
      { type: 'integration', slug: 'mail', index: 0 },
      { type: 'service', slug: 'web', index: 0 },
      { type: 'service', slug: 'web', index: 1 }
    ])
    expect(apiOf(configure).lines).toEqual([
      { type: 'command', slug: 'dev', index: 0 },
      { type: 'files', slug: 'data', index: 0 }
    ])
  })

  it('warns about shortcuts naming nothing of the directory', async () => {
    const configure = await loadApi({ ...settings, icons: ['service:web:2', 'service:web:x', 'files:ghost', 'integration:ghost', 'page:home', 5], lines: 'command:dev' })
    expect(apiOf(configure).icons).toEqual([])
    expect(apiOf(configure).lines).toEqual([])
    expect(configure.warnings).toEqual([
      `${API}.icons[0]: service:web:2 names no integration, command, files or service host of the directory.`,
      `${API}.icons[1]: service:web:x names no integration, command, files or service host of the directory.`,
      `${API}.icons[2]: files:ghost names no integration, command, files or service host of the directory.`,
      `${API}.icons[3]: integration:ghost names no integration, command, files or service host of the directory.`,
      `${API}.icons[4]: page:home names no integration, command, files or service host of the directory.`,
      `${API}.icons[5]: must be <type>:<slug>.`,
      `${API}.lines: must be a list of <type>:<slug>.`
    ])
  })
})

describe('MCP rules of sections and directories', () => {
  it('applies the rules of a section, then of a directory, then of a command', async () => {
    const configure = await loadApi(
      { mcp: { run: 'allow' }, extras: { dev: { name: 'Dev', args: ['pnpm', 'dev'], mcp: { input: 'allow' } } }, files: { data: { path: 'data' } } },
      { mcp: 'deny' }
    )
    expect(configure.warnings).toEqual([])
    const section = configure.projects.main
    const api = apiOf(configure)
    expect(section.mcp).toEqual(rulesOf('deny', 'sections.main'))
    expect(section.restoreRule).toEqual({ level: 'deny', from: 'sections.main' })
    expect(api.mcp).toEqual({ ...rulesOf('deny', 'sections.main'), run: { level: 'allow', from: 'projects.api' } })
    expect(api.restoreRule).toEqual({ level: 'allow', from: 'projects.api' })
    expect(api.extras.dev.mcp).toEqual({
      ...rulesOf('deny', 'sections.main'),
      run: { level: 'allow', from: 'projects.api' },
      input: { level: 'allow', from: 'projects.api.commands.dev' }
    })
    expect(api.files.data.mcp).toEqual({ ...rulesOf('deny', 'sections.main'), run: { level: 'allow', from: 'projects.api' } })
  })

  it('starts the commands of a directory from the rules of commands', async () => {
    const configure = await loadApi({ extras: { dev: { name: 'Dev', args: ['pnpm', 'dev'] } } }, {}, { adt: { mcp: { commands: { run: 'allow' } } } })
    expect(apiOf(configure).extras.dev.mcp.run).toEqual({ level: 'allow', from: 'adt.mcp.commands' })
    expect(apiOf(configure).mcp.run).toEqual({ level: 'ask', from: 'default' })
  })

  it('warns about invalid rules of sections, directories and commands', async () => {
    const configure = await loadApi({ mcp: 'never', extras: { dev: { name: 'Dev', args: ['x'], mcp: { fly: 'allow' } } } }, { mcp: 'keys' })
    expect(configure.warnings).toEqual([
      'projects[main].mcp: keys is for the settings of files only.',
      `${API}.mcp: must be one of allow, keys, ask, deny, or levels by action (read, run, input, control, write).`,
      `${API}.extras[dev].mcp: fly is not an action (read, run, input, control, write).`
    ])
  })
})

describe('setting targets', () => {
  const shared = '/config/config.yml'
  const sections = '/config/sections.yml'
  const local = '/config/config.local.yml'

  /**
   * Gives where the settings of the configuration come from.
   * @returns The origin of the settings.
   */
  function origin (): ConfigOrigin {
    return {
      sources: {
        [configSourceKey(['adt', 'mcp', 'default'])]: [shared, sections, local],
        [configSourceKey(['adt', 'mcp', 'commands'])]: [local],
        [configSourceKey(['adt', 'mcp'])]: [sections, shared],
        [configSourceKey(['sections', 'main'])]: [sections]
      },
      localPath: local,
      sharedPath: shared
    }
  }

  it('gives the last shared file declaring a setting', async () => {
    const configure = await load({}, origin())
    expect(configure.settingTarget(['adt', 'mcp', 'default'])).toEqual({ path: ['adt', 'mcp', 'default'], declaredIn: sections })
  })

  it('gives the first shared file declaring what holds a setting declared by the personal file only', async () => {
    const configure = await load({}, origin())
    expect(configure.settingTarget(['adt', 'mcp', 'commands'])).toEqual({ path: ['adt', 'mcp', 'commands'], declaredIn: sections })
    expect(configure.settingTarget(['sections', 'main', 'mcp'])).toEqual({ path: ['sections', 'main', 'mcp'], declaredIn: sections })
  })

  it('gives the shared configuration for a setting nothing declares', async () => {
    const configure = await load({}, origin())
    expect(configure.settingTarget(['projects', 'api', 'mcp'])).toEqual({ path: ['projects', 'api', 'mcp'], declaredIn: shared })
    expect(configure.localPath).toBe(local)
  })

  it('tells the interfaces where the MCP settings are written', async () => {
    const configure = await load({}, origin())
    const { mcp } = configure.getForClient('2.0.0')
    expect(mcp.localFile).toBe(local)
    expect(Object.keys(mcp.targets)).toEqual(['default', 'commands', 'scripts', 'files', 'terminals', 'certificates', 'devtool', 'ownTerminals', 'shell', 'clients', 'environment'])
    expect(mcp.targets.default).toEqual({ path: ['adt', 'mcp', 'default'], declaredIn: sections })
    expect(mcp.targets.shell).toEqual({ path: ['adt', 'mcp', 'shell', 'level'], declaredIn: sections })
    expect(mcp.targets.environment).toEqual({ path: ['environment', 'mcp'], declaredIn: shared })
  })
})

describe('getForClient', () => {
  it('gives the interfaces the version, names, warnings, sidebar and MCP settings', async () => {
    const configure = await load({ adt: { displayName: 'Web Tools', ports: { server: 7000 }, mcp: { enabled: true } }, passthrough: 'all' })
    const client = configure.getForClient('1.2.3')
    expect(client).toMatchObject({
      version: '1.2.3',
      name: 'web-tools',
      displayName: 'Web Tools',
      warnings: ['passthrough: must be an array.'],
      loadBalancers: [],
      integrations: [],
      projects: {},
      sidebar: configure.adt.sidebar,
      agents: []
    })
    expect(client.mcp).toMatchObject({ enabled: true, port: 7000, certificatesByName: {}, localFile: null })
  })
})

describe('findMcpTarget', () => {
  it('finds the MCP settings the interfaces may change', async () => {
    await writeFile('api/scripts/deploy.sh', '#!/bin/sh\n', 0o755)
    const configure = await loadApi(
      { extras: { dev: { name: 'Dev', args: ['pnpm', 'dev'] } }, scripts: ['scripts'], files: { data: { path: 'data' } } },
      {},
      { loadBalancers: { 'example.dev': { crt: 'a.crt', key: 'a.key' } }, environment: { files: ['app.yml'] } }
    )
    expect(configure.warnings).toEqual([])
    for (const settingPath of [
      ['adt', 'mcp', 'default'],
      ['adt', 'mcp', 'commands'],
      ['adt', 'mcp', 'ownTerminals'],
      ['adt', 'mcp', 'shell', 'level'],
      ['adt', 'mcp', 'clients', 'level'],
      ['environment', 'mcp'],
      ['environment', 'files', '0', 'mcp'],
      ['loadBalancers', 'example.dev', 'mcp'],
      ['sections', 'main', 'mcp'],
      ['projects', 'api', 'mcp'],
      ['projects', 'api', 'commands', 'dev', 'mcp'],
      ['projects', 'api', 'scripts', '0', 'mcp'],
      ['projects', 'api', 'scripts', '0', 'scripts', 'deploy.sh', 'mcp'],
      ['projects', 'api', 'files', 'data', 'mcp']
    ]) {
      expect(configure.findMcpTarget(settingPath)).toEqual({ path: settingPath, declaredIn: null })
    }
  })

  it('finds nothing for other settings', async () => {
    const configure = await loadApi()
    expect(configure.findMcpTarget(['adt', 'mcp', 'shell'])).toBeNull()
    expect(configure.findMcpTarget(['projects', 'api', 'commands', 'ghost', 'mcp'])).toBeNull()
    expect(configure.findMcpTarget([])).toBeNull()
  })
})
