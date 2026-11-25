import type { DirectoryExtra, McpAction, McpAnswer, McpDecision, McpLevel, ProjectDefinition } from '@appsys-sas/devtool-shared'

/** How each decision of a call is shown. */
export const DECISIONS: Record<McpDecision, { label: string, class: string }> = {
  auto: { label: 'Auto', class: 'border-transparent bg-muted text-muted-foreground' },
  once: { label: 'Once', class: 'border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300' },
  session: { label: 'Session', class: 'border-transparent bg-indigo-500/15 text-indigo-700 dark:text-indigo-300' },
  always: { label: 'Always', class: 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  denied: { label: 'Denied', class: 'border-transparent bg-destructive/15 text-destructive' },
  config: { label: 'Config', class: 'border-transparent bg-rose-500/10 text-rose-700 dark:text-rose-300' },
  timeout: { label: 'Timeout', class: 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  noUi: { label: 'No UI', class: 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  cancelled: { label: 'Cancelled', class: 'border-transparent bg-muted text-muted-foreground' }
}

/** How each level of an action is shown. */
export const LEVELS: Record<McpLevel, string> = {
  allow: 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  keys: 'border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300',
  ask: 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300',
  deny: 'border-transparent bg-destructive/15 text-destructive'
}

/** How an agent declares the MCP server of the devtool for every project of its user. */
export interface McpAgentSetup {
  /** The command line declaring it. */
  command?: string
  /** The file holding the configuration, when it is written by hand. */
  file?: string
  /** The configuration declaring it. */
  config?: string
  /** Where the configuration goes when no file holds it, or what to do after. */
  note?: string
}

/** An agent able to use the MCP server of the devtool. */
export interface McpAgent {
  id: string
  label: string
  icon: string
  /** Matches the name or display name it gives, lowercased. */
  pattern: RegExp
  /**
   * Gives how it declares the server.
   * @param name The name the server is declared under.
   * @param url The address of the server.
   * @returns The setup.
   */
  setup(name: string, url: string): McpAgentSetup
}

/**
 * Writes the JSON of a configuration.
 * @param value The configuration.
 * @returns The JSON, indented.
 */
function json (value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** The known agents, the first whose pattern matches naming an agent. */
export const MCP_AGENTS: McpAgent[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    icon: 'simple-icons:claude',
    pattern: /claude/,
    setup: (name, url) => ({ command: `claude mcp add --scope user --transport http ${name} ${url}` })
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    icon: 'simple-icons:claude',
    pattern: /claude/,
    setup: (name, url) => ({
      file: '~/Library/Application Support/Claude/claude_desktop_config.json',
      config: json({ mcpServers: { [name]: { command: 'npx', args: ['-y', 'mcp-remote', url, '--transport', 'http-only'] } } }),
      note: 'Claude Desktop only runs local servers, through the mcp-remote bridge. Restart it afterwards.'
    })
  },
  {
    id: 'codex',
    label: 'Codex',
    icon: 'simple-icons:openai',
    pattern: /codex|openai|chatgpt/,
    setup: (name, url) => ({ command: `codex mcp add ${name} --url ${url}`, file: '~/.codex/config.toml', config: `[mcp_servers.${name}]\nurl = "${url}"` })
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    icon: 'simple-icons:googlegemini',
    pattern: /gemini/,
    setup: (name, url) => ({ command: `gemini mcp add -s user -t http ${name} ${url}` })
  },
  {
    id: 'opencode',
    label: 'opencode',
    icon: 'simple-icons:opencode',
    pattern: /opencode/,
    setup: (name, url) => ({
      command: `opencode mcp add ${name} --global --url ${url}`,
      file: '~/.config/opencode/opencode.json',
      config: json({ $schema: 'https://opencode.ai/config.json', mcp: { servers: { [name]: { type: 'remote', url, oauth: false } } } })
    })
  },
  {
    id: 'cursor',
    label: 'Cursor',
    icon: 'simple-icons:cursor',
    pattern: /cursor/,
    setup: (name, url) => ({ file: '~/.cursor/mcp.json', config: json({ mcpServers: { [name]: { url } } }) })
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot (VS Code, CLI)',
    icon: 'simple-icons:githubcopilot',
    pattern: /copilot|visual studio code|vscode/,
    setup: (name, url) => ({
      command: `copilot mcp add --transport http ${name} ${url}`,
      file: '~/.copilot/mcp-config.json',
      config: json({ mcpServers: { [name]: { type: 'http', url, tools: ['*'] } } })
    })
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    icon: 'simple-icons:windsurf',
    pattern: /windsurf|codeium/,
    setup: (name, url) => ({
      file: '~/.config/devin/mcp_config.json',
      config: json({ mcpServers: { [name]: { serverUrl: url } } }),
      note: 'Or the file Cascade opens with Open MCP config file.'
    })
  },
  {
    id: 'zed',
    label: 'Zed',
    icon: 'simple-icons:zedindustries',
    pattern: /\bzed\b/,
    setup: (name, url) => ({ file: '~/.config/zed/settings.json', config: json({ context_servers: { [name]: { url } } }) })
  },
  {
    id: 'cline',
    label: 'Cline',
    icon: 'simple-icons:cline',
    pattern: /cline/,
    setup: (name, url) => ({
      command: `cline mcp add ${name} ${url} --transport http --yes`,
      file: '~/.cline/data/settings/cline_mcp_settings.json',
      config: json({ mcpServers: { [name]: { type: 'streamableHttp', url } } })
    })
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    icon: 'simple-icons:qwen',
    pattern: /qwen/,
    setup: (name, url) => ({ command: `qwen mcp add --scope user --transport http ${name} ${url}` })
  },
  {
    id: 'vibe',
    label: 'Mistral Vibe',
    icon: 'simple-icons:mistralai',
    pattern: /mistral|vibe/,
    setup: (name, url) => ({ file: '~/.vibe/config.toml', config: `[[mcp_servers]]\nname = "${name}"\ntransport = "streamable-http"\nurl = "${url}"` })
  },
  {
    id: 'junie',
    label: 'Junie',
    icon: 'simple-icons:jetbrains',
    pattern: /junie/,
    setup: (name, url) => ({ file: '~/.junie/mcp/mcp.json', config: json({ mcpServers: { [name]: { url } } }) })
  },
  {
    id: 'jetbrains-ai',
    label: 'JetBrains AI Assistant',
    icon: 'simple-icons:jetbrains',
    pattern: /jetbrains/,
    setup: (name, url) => ({
      config: json({ mcpServers: { [name]: { url } } }),
      note: 'Paste it in Settings > Tools > AI Assistant > Model Context Protocol (MCP) > Add, as a global Streamable HTTP server.'
    })
  },
  {
    id: 'warp',
    label: 'Warp',
    icon: 'simple-icons:warp',
    pattern: /warp/,
    setup: (name, url) => ({ file: '~/.warp/.mcp.json', config: json({ mcpServers: { [name]: { url } } }) })
  }
]

/**
 * Gives the icon of an agent from what it calls itself.
 * @param names Its name and display name.
 * @returns The icon of a known agent, else a generic one.
 */
export function agentIcon (...names: string[]): string {
  const text = names.join(' ').toLowerCase()
  return MCP_AGENTS.find(agent => agent.pattern.test(text))?.icon ?? 'lucide:bot'
}

/** The labels of the answers to a request. */
export const ANSWERS: Record<McpAnswer, string> = {
  deny: 'Deny',
  once: 'Allow once',
  session: 'This session',
  always: 'Always'
}

/**
 * Finds a command of the configuration from its identifier for agents.
 * @param projects The sections of the configuration.
 * @param id `<section>/<project>/<slug>`, the slug of a script being its path.
 * @returns The command, null when it is unknown.
 */
export function findMcpCommand (projects: Record<string, ProjectDefinition> | null, id: string): DirectoryExtra | null {
  const [section, project, ...slug] = id.split('/')
  return projects?.[section]?.directories[project]?.extras[slug.join('/')] ?? null
}

/** A level of an MCP setting changed from the Agents page, written once the edit is done. */
export interface McpLevelChange {
  path: string[]
  /** The action changed, null for a setting being a level itself. */
  action: McpAction | null
  /** The new level, null to inherit it. */
  level: McpLevel | null
  file: 'local' | 'declared'
}

/** Where the permissions changed from the Agents page are written, and the changes waiting, while it is in edit mode. */
export interface McpEditMode {
  /** The personal override, or the file declaring each setting. */
  file: 'local' | 'declared'
  /** The personal override, null when the server loads none. */
  localFile: string | null
  /** The changes waiting, by {@link changeKey}. */
  staged: ReadonlyMap<string, McpLevelChange>
  /**
   * Keeps a change until the edit is done, replacing the one of the same setting and action.
   * @param change The change.
   */
  stage(change: McpLevelChange): void
}

/**
 * Names the setting and action a change applies to.
 * @param path The keys leading to the setting.
 * @param action The action, null for a setting being a level itself.
 * @returns The key.
 */
export function changeKey (path: string[], action: McpAction | null): string {
  return `${path.join('/')}#${action ?? ''}`
}

/**
 * Shortens the path of a configuration file to its last folders.
 * @param file The absolute path.
 * @returns The file with its two parent folders.
 */
export function shortPath (file: string): string {
  return file.split('/').slice(-3).join('/')
}
