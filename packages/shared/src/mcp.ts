import type { McpAction, McpLevel, McpRules, McpSettings } from './types.js'

/** Every action of an agent, in the order they are shown. */
export const MCP_ACTIONS: readonly McpAction[] = ['read', 'run', 'input', 'control', 'write']

/** Every level of an action, from the most to the least permissive. */
export const MCP_LEVELS: readonly McpLevel[] = ['allow', 'keys', 'ask', 'deny']

/** The actions on files, the only ones accepting the `keys` level. */
const KEYS_ACTIONS: readonly McpAction[] = ['read', 'write']

/**
 * Gives the rules of everything when the configuration declares none: seeing is allowed, anything
 * else is asked.
 * @param from The setting the rules come from.
 * @returns The rules.
 */
export function defaultMcpRules (from: string): McpRules {
  return {
    read: { level: 'allow', from },
    run: { level: 'ask', from },
    input: { level: 'ask', from },
    control: { level: 'ask', from },
    write: { level: 'ask', from }
  }
}

/**
 * Tells whether a value is a level of an action.
 * @param value The value.
 * @returns True for a level.
 */
export function isMcpLevel (value: unknown): value is McpLevel {
  return typeof value === 'string' && (MCP_LEVELS as readonly string[]).includes(value)
}

/**
 * Tells whether an `mcp` setting is about files only, the only settings accepting the `keys` level:
 * `adt.mcp.files`, the folders of files of the projects, the environment and its files.
 * @param settingPath The keys leading to the setting, from the root of the configuration.
 * @returns True for a setting about files.
 */
export function isMcpFilesSetting (settingPath: readonly string[]): boolean {
  const [root, second, third] = settingPath
  if (root === 'environment') {
    return second === undefined || second === 'mcp' || second === 'files'
  }
  return (root === 'adt' && second === 'mcp' && third === 'files') || (root === 'projects' && third === 'files')
}

/**
 * Gives the rules of an item of the environment: its own, those of the YAML file it is the `.local.yml`
 * override of, else those of the whole environment.
 * @param settings The MCP settings.
 * @param itemPath The path of the item in the environment.
 * @returns The rules.
 */
export function environmentRules (settings: Pick<McpSettings, 'environment' | 'environmentItems'>, itemPath: string): McpRules {
  const item = settings.environmentItems.find(candidate => candidate.path === itemPath || candidate.path.replace(/\.ya?ml$/, '.local.yml') === itemPath)
  return item?.rules ?? settings.environment
}

/**
 * Gives the levels an action accepts: `keys` for reading and writing, in a setting about files only.
 * @param action The action.
 * @param files Whether the setting is about files.
 * @returns The levels, from the most to the least permissive.
 */
export function mcpLevelsFor (action: McpAction, files: boolean): McpLevel[] {
  return MCP_LEVELS.filter(level => level !== 'keys' || (files && KEYS_ACTIONS.includes(action)))
}

/**
 * Reads the levels an `mcp` setting declares: a level for every action it accepts, or levels by action.
 * @param value The raw setting, undefined when it is not declared.
 * @param files Whether the setting is about files, accepting the `keys` level.
 * @returns The levels by action, and the problems of the setting.
 */
export function mcpLevelsOf (value: unknown, files: boolean): { levels: Partial<Record<McpAction, McpLevel>>, problems: string[] } {
  if (value === undefined) {
    return { levels: {}, problems: [] }
  }
  if (value === 'keys' && !files) {
    return { levels: {}, problems: ['keys is for the settings of files only'] }
  }
  if (isMcpLevel(value)) {
    return { levels: Object.fromEntries(MCP_ACTIONS.filter(action => mcpLevelsFor(action, files).includes(value)).map(action => [action, value])), problems: [] }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { levels: {}, problems: [`must be one of ${MCP_LEVELS.join(', ')}, or levels by action (${MCP_ACTIONS.join(', ')})`] }
  }

  const levels: Partial<Record<McpAction, McpLevel>> = {}
  const problems: string[] = []
  for (const [action, level] of Object.entries(value)) {
    if (!(MCP_ACTIONS as readonly string[]).includes(action)) {
      problems.push(`${action} is not an action (${MCP_ACTIONS.join(', ')})`)
    } else if (!isMcpLevel(level) || !mcpLevelsFor(action as McpAction, files).includes(level)) {
      problems.push(`${action} must be one of ${mcpLevelsFor(action as McpAction, files).join(', ')}`)
    } else {
      levels[action as McpAction] = level
    }
  }
  return { levels, problems }
}

/**
 * Reads the `mcp` setting of something of the configuration over the rules it inherits: a level for
 * every action (`keys` for reading and writing, in a setting about files only), or levels by action.
 * @param value The raw setting, undefined when it is not declared.
 * @param inherited The rules of what holds it.
 * @param from Names the setting in the rules it declares, its path in the configuration.
 * @returns The rules, and the problems of the setting.
 */
export function readMcpRules (value: unknown, inherited: McpRules, from: string): { rules: McpRules, problems: string[] } {
  const { levels, problems } = mcpLevelsOf(value, isMcpFilesSetting(from.split('.')))
  const rules: McpRules = { ...inherited }
  for (const [action, level] of Object.entries(levels)) {
    rules[action as McpAction] = { level, from }
  }
  return { rules, problems }
}
