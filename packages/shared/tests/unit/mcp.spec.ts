import { describe, expect, it } from 'vitest'
import { defaultMcpRules, environmentRules, isMcpFilesSetting, isMcpLevel, MCP_ACTIONS, MCP_LEVELS, mcpLevelsFor, mcpLevelsOf, readMcpRules } from '../../src/mcp.js'
import type { McpAction, McpEnvironmentItem, McpLevel, McpRules } from '../../src/types.js'

const SHAPE_PROBLEM = 'must be one of allow, keys, ask, deny, or levels by action (read, run, input, control, write)'

/**
 * Builds rules giving the same level to every action.
 * @param level - The level of every action.
 * @param from - The setting the rules come from.
 * @returns The rules.
 */
function uniformRules (level: McpLevel, from: string): McpRules {
  return Object.fromEntries(MCP_ACTIONS.map(action => [action, { level, from }])) as McpRules
}

/**
 * Builds an item of the environment with the given path and rules.
 * @param path - The path of the item in the environment.
 * @param rules - The rules of the item.
 * @returns The item.
 */
function environmentItem (path: string, rules: McpRules): McpEnvironmentItem {
  return { path, kind: 'file', rules, target: { path: ['environment', 'files', '0', 'mcp'], declaredIn: null } }
}

describe('MCP_ACTIONS and MCP_LEVELS', () => {
  it('lists the actions in the order they are shown', () => {
    expect(MCP_ACTIONS).toEqual(['read', 'run', 'input', 'control', 'write'])
  })

  it('lists the levels from the most to the least permissive', () => {
    expect(MCP_LEVELS).toEqual(['allow', 'keys', 'ask', 'deny'])
  })
})

describe('defaultMcpRules', () => {
  it('allows reading and asks for anything else, naming the setting', () => {
    expect(defaultMcpRules('adt.mcp.default')).toEqual({
      read: { level: 'allow', from: 'adt.mcp.default' },
      run: { level: 'ask', from: 'adt.mcp.default' },
      input: { level: 'ask', from: 'adt.mcp.default' },
      control: { level: 'ask', from: 'adt.mcp.default' },
      write: { level: 'ask', from: 'adt.mcp.default' }
    })
  })

  it('gives a rule for every action', () => {
    expect(Object.keys(defaultMcpRules('x'))).toEqual([...MCP_ACTIONS])
  })

  it('gives new rules on every call', () => {
    const first = defaultMcpRules('x')
    first.read.level = 'deny'
    expect(defaultMcpRules('x').read.level).toBe('allow')
  })
})

describe('isMcpLevel', () => {
  it('accepts the levels and refuses anything else', () => {
    expect(isMcpLevel('allow')).toBe(true)
    expect(isMcpLevel('never')).toBe(false)
    expect(isMcpLevel(1)).toBe(false)
  })

  it.each(['allow', 'keys', 'ask', 'deny'])('accepts %s', level => {
    expect(isMcpLevel(level)).toBe(true)
  })

  it.each([['ALLOW'], [''], [' allow'], [undefined], [null], [true], [{}], [['allow']], [{ level: 'allow' }]])('refuses %j', value => {
    expect(isMcpLevel(value)).toBe(false)
  })
})

describe('isMcpFilesSetting', () => {
  it.each([
    [['environment']],
    [['environment', 'mcp']],
    [['environment', 'files']],
    [['environment', 'files', '0', 'mcp']],
    [['adt', 'mcp', 'files']],
    [['adt', 'mcp', 'files', 'read']],
    [['projects', 'web', 'files']],
    [['projects', 'web', 'files', 'docs', 'mcp']]
  ])('takes %j as a setting about files', settingPath => {
    expect(isMcpFilesSetting(settingPath)).toBe(true)
  })

  it.each([
    [[]],
    [['environment', 'databases']],
    [['environment', 'databases', '0', 'mcp']],
    [['environment', 'buckets', '1']],
    [['adt']],
    [['adt', 'mcp']],
    [['adt', 'mcp', 'default']],
    [['adt', 'mcp', 'commands']],
    [['adt', 'files']],
    [['adt', 'other', 'files']],
    [['projects', 'web']],
    [['projects', 'files']],
    [['projects', 'web', 'commands', 'dev']],
    [['projects', 'web', 'scripts']],
    [['sections', 'web', 'files']],
    [['loadBalancers', 'main']]
  ])('does not take %j as a setting about files', settingPath => {
    expect(isMcpFilesSetting(settingPath)).toBe(false)
  })
})

describe('environmentRules', () => {
  const whole = uniformRules('ask', 'environment')
  const config = uniformRules('allow', 'environment.files.0')
  const secrets = uniformRules('deny', 'environment.files.1')
  const database = uniformRules('keys', 'environment.databases.0')
  const settings = {
    environment: whole,
    environmentItems: [environmentItem('config.yml', config), environmentItem('secrets.yaml', secrets), environmentItem('main', database)]
  }

  it('gives the rules of the item with that path', () => {
    expect(environmentRules(settings, 'config.yml')).toBe(config)
    expect(environmentRules(settings, 'secrets.yaml')).toBe(secrets)
    expect(environmentRules(settings, 'main')).toBe(database)
  })

  it('gives the rules of the YAML file a .local.yml file overrides', () => {
    expect(environmentRules(settings, 'config.local.yml')).toBe(config)
    expect(environmentRules(settings, 'secrets.local.yml')).toBe(secrets)
  })

  it('gives the rules of the whole environment for any other path', () => {
    expect(environmentRules(settings, 'other.yml')).toBe(whole)
    expect(environmentRules(settings, 'config.local.yaml')).toBe(whole)
    expect(environmentRules(settings, 'main.local.yml')).toBe(whole)
    expect(environmentRules(settings, 'config')).toBe(whole)
    expect(environmentRules(settings, '')).toBe(whole)
  })

  it('gives the rules of the whole environment without items', () => {
    expect(environmentRules({ environment: whole, environmentItems: [] }, 'config.yml')).toBe(whole)
  })

  it('gives the rules of the first item matching the path', () => {
    const own = uniformRules('deny', 'environment.files.1')
    const items = [environmentItem('app.yml', config), environmentItem('app.local.yml', own)]
    expect(environmentRules({ environment: whole, environmentItems: items }, 'app.local.yml')).toBe(config)
    expect(environmentRules({ environment: whole, environmentItems: [...items].reverse() }, 'app.local.yml')).toBe(own)
  })
})

describe('mcpLevelsFor', () => {
  it.each(['read', 'write'] as McpAction[])('accepts keys for %s in a setting about files', action => {
    expect(mcpLevelsFor(action, true)).toEqual(['allow', 'keys', 'ask', 'deny'])
  })

  it.each(['read', 'write'] as McpAction[])('refuses keys for %s in any other setting', action => {
    expect(mcpLevelsFor(action, false)).toEqual(['allow', 'ask', 'deny'])
  })

  it.each(['run', 'input', 'control'] as McpAction[])('never accepts keys for %s', action => {
    expect(mcpLevelsFor(action, true)).toEqual(['allow', 'ask', 'deny'])
    expect(mcpLevelsFor(action, false)).toEqual(['allow', 'ask', 'deny'])
  })

  it('gives a new list each time', () => {
    const levels = mcpLevelsFor('read', true)
    levels.pop()
    expect(mcpLevelsFor('read', true)).toEqual(['allow', 'keys', 'ask', 'deny'])
    expect(MCP_LEVELS).toEqual(['allow', 'keys', 'ask', 'deny'])
  })
})

describe('mcpLevelsOf', () => {
  it.each([true, false])('declares nothing without a setting (files: %s)', files => {
    expect(mcpLevelsOf(undefined, files)).toEqual({ levels: {}, problems: [] })
  })

  it.each(['allow', 'ask', 'deny'] as McpLevel[])('gives %s to every action', level => {
    const levels = Object.fromEntries(MCP_ACTIONS.map(action => [action, level]))
    expect(mcpLevelsOf(level, false)).toEqual({ levels, problems: [] })
    expect(mcpLevelsOf(level, true)).toEqual({ levels, problems: [] })
  })

  it('gives keys to reading and writing only in a setting about files', () => {
    expect(mcpLevelsOf('keys', true)).toEqual({ levels: { read: 'keys', write: 'keys' }, problems: [] })
  })

  it('refuses keys as a level in any other setting', () => {
    expect(mcpLevelsOf('keys', false)).toEqual({ levels: {}, problems: ['keys is for the settings of files only'] })
  })

  it.each([['never'], ['ALLOW'], [''], [1], [0], [true], [false], [null], [[]], [['allow']]])('refuses %j as a setting', value => {
    expect(mcpLevelsOf(value, false)).toEqual({ levels: {}, problems: [SHAPE_PROBLEM] })
    expect(mcpLevelsOf(value, true)).toEqual({ levels: {}, problems: [SHAPE_PROBLEM] })
  })

  it('declares nothing for empty levels by action', () => {
    expect(mcpLevelsOf({}, false)).toEqual({ levels: {}, problems: [] })
  })

  it('reads levels by action', () => {
    expect(mcpLevelsOf({ read: 'deny', run: 'allow', input: 'ask', control: 'deny', write: 'allow' }, false)).toEqual({
      levels: { read: 'deny', run: 'allow', input: 'ask', control: 'deny', write: 'allow' },
      problems: []
    })
  })

  it('declares only the actions it names', () => {
    expect(mcpLevelsOf({ run: 'deny' }, false)).toEqual({ levels: { run: 'deny' }, problems: [] })
  })

  it('accepts keys for reading and writing in a setting about files', () => {
    expect(mcpLevelsOf({ read: 'keys', write: 'keys', run: 'allow' }, true)).toEqual({
      levels: { read: 'keys', write: 'keys', run: 'allow' },
      problems: []
    })
  })

  it('refuses keys for reading and writing in any other setting', () => {
    expect(mcpLevelsOf({ read: 'keys', write: 'keys' }, false)).toEqual({
      levels: {},
      problems: ['read must be one of allow, ask, deny', 'write must be one of allow, ask, deny']
    })
  })

  it.each(['run', 'input', 'control'])('refuses keys for %s even in a setting about files', action => {
    expect(mcpLevelsOf({ [action]: 'keys' }, true)).toEqual({ levels: {}, problems: [`${action} must be one of allow, ask, deny`] })
  })

  it('lists the levels an action accepts when its level is invalid', () => {
    expect(mcpLevelsOf({ read: 'never' }, true)).toEqual({ levels: {}, problems: ['read must be one of allow, keys, ask, deny'] })
    expect(mcpLevelsOf({ read: 'never' }, false)).toEqual({ levels: {}, problems: ['read must be one of allow, ask, deny'] })
    expect(mcpLevelsOf({ run: 'never' }, true)).toEqual({ levels: {}, problems: ['run must be one of allow, ask, deny'] })
  })

  it.each([[null], [undefined], [1], [true], [['allow']], [{ level: 'allow' }], ['Allow']])('refuses %j as the level of an action', level => {
    expect(mcpLevelsOf({ input: level }, false)).toEqual({ levels: {}, problems: ['input must be one of allow, ask, deny'] })
  })

  it('refuses what is not an action', () => {
    expect(mcpLevelsOf({ delete: 'allow' }, false)).toEqual({ levels: {}, problems: ['delete is not an action (read, run, input, control, write)'] })
    expect(mcpLevelsOf({ Read: 'allow' }, true)).toEqual({ levels: {}, problems: ['Read is not an action (read, run, input, control, write)'] })
  })

  it('keeps the valid levels and lists every problem in order', () => {
    expect(mcpLevelsOf({ read: 'allow', foo: 'deny', run: 'keys', write: 'ask', control: 'maybe' }, false)).toEqual({
      levels: { read: 'allow', write: 'ask' },
      problems: [
        'foo is not an action (read, run, input, control, write)',
        'run must be one of allow, ask, deny',
        'control must be one of allow, ask, deny'
      ]
    })
  })
})

describe('readMcpRules', () => {
  const inherited = defaultMcpRules('adt.mcp.default')

  /**
   * Splits a dotted setting path into its keys.
   * @param from - The dotted path.
   * @returns The keys.
   */
  const keysOf = (from: string): string[] => from.split('.')

  it('keeps the inherited rules without a setting', () => {
    expect(readMcpRules(undefined, inherited, keysOf('adt.mcp.commands'))).toEqual({ rules: inherited, problems: [] })
  })

  it('gives a level to every action, naming the setting', () => {
    expect(readMcpRules('deny', inherited, keysOf('adt.mcp.commands'))).toEqual({ rules: uniformRules('deny', 'adt.mcp.commands'), problems: [] })
  })

  it('reads the files of a project whose slug holds dots', () => {
    expect(readMcpRules('keys', inherited, ['projects', 'my.app', 'files', 'docs']).rules.read).toEqual({ level: 'keys', from: 'projects.my.app.files.docs' })
  })

  it('overrides only the actions declared by action', () => {
    expect(readMcpRules({ run: 'allow', write: 'deny' }, inherited, keysOf('sections.web'))).toEqual({
      rules: {
        read: { level: 'allow', from: 'adt.mcp.default' },
        run: { level: 'allow', from: 'sections.web' },
        input: { level: 'ask', from: 'adt.mcp.default' },
        control: { level: 'ask', from: 'adt.mcp.default' },
        write: { level: 'deny', from: 'sections.web' }
      },
      problems: []
    })
  })

  it('names the setting even when its level matches the inherited one', () => {
    expect(readMcpRules({ read: 'allow' }, inherited, keysOf('adt.mcp.files')).rules.read).toEqual({ level: 'allow', from: 'adt.mcp.files' })
  })

  it('does not change the inherited rules', () => {
    const before = structuredClone(inherited)
    readMcpRules('deny', inherited, keysOf('adt.mcp.commands'))
    readMcpRules({ read: 'deny' }, inherited, keysOf('adt.mcp.commands'))
    expect(inherited).toEqual(before)
  })

  it.each(['adt.mcp.files', 'environment', 'environment.files.0', 'projects.web.files.docs'])('gives keys to reading and writing in %s', from => {
    expect(readMcpRules('keys', inherited, keysOf(from))).toEqual({
      rules: {
        read: { level: 'keys', from },
        run: { level: 'ask', from: 'adt.mcp.default' },
        input: { level: 'ask', from: 'adt.mcp.default' },
        control: { level: 'ask', from: 'adt.mcp.default' },
        write: { level: 'keys', from }
      },
      problems: []
    })
  })

  it.each(['adt.mcp.default', 'adt.mcp.commands', 'environment.databases.0', 'projects.web', 'projects.web.commands.dev', 'sections.web', 'loadBalancers.main'])('refuses keys in %s and keeps the inherited rules', from => {
    expect(readMcpRules('keys', inherited, keysOf(from))).toEqual({ rules: inherited, problems: ['keys is for the settings of files only'] })
  })

  it('refuses keys by action outside a setting about files', () => {
    expect(readMcpRules({ read: 'keys', run: 'deny' }, inherited, keysOf('projects.web'))).toEqual({
      rules: { ...inherited, run: { level: 'deny', from: 'projects.web' } },
      problems: ['read must be one of allow, ask, deny']
    })
  })

  it('accepts keys by action in a setting about files', () => {
    expect(readMcpRules({ write: 'keys' }, inherited, keysOf('projects.web.files.docs')).rules.write).toEqual({ level: 'keys', from: 'projects.web.files.docs' })
  })

  it('keeps the inherited rules and reports an invalid setting', () => {
    expect(readMcpRules('never', inherited, keysOf('adt.mcp.commands'))).toEqual({ rules: inherited, problems: [SHAPE_PROBLEM] })
    expect(readMcpRules(['allow'], inherited, keysOf('adt.mcp.commands'))).toEqual({ rules: inherited, problems: [SHAPE_PROBLEM] })
  })

  it('applies the valid levels and reports the others', () => {
    expect(readMcpRules({ control: 'deny', kill: 'allow', input: 'yes' }, inherited, keysOf('sections.web'))).toEqual({
      rules: { ...inherited, control: { level: 'deny', from: 'sections.web' } },
      problems: ['kill is not an action (read, run, input, control, write)', 'input must be one of allow, ask, deny']
    })
  })

  it('inherits through every level of the configuration', () => {
    const category = readMcpRules({ run: 'allow' }, inherited, keysOf('adt.mcp.commands')).rules
    const section = readMcpRules({ control: 'deny' }, category, keysOf('sections.web')).rules
    const command = readMcpRules({ input: 'allow' }, section, keysOf('projects.web.commands.dev')).rules
    expect(command).toEqual({
      read: { level: 'allow', from: 'adt.mcp.default' },
      run: { level: 'allow', from: 'adt.mcp.commands' },
      input: { level: 'allow', from: 'projects.web.commands.dev' },
      control: { level: 'deny', from: 'sections.web' },
      write: { level: 'ask', from: 'adt.mcp.default' }
    })
  })

  it('lets a deeper setting override a level a parent declared', () => {
    const category = readMcpRules('deny', inherited, keysOf('adt.mcp.files')).rules
    const folder = readMcpRules({ read: 'keys' }, category, keysOf('projects.web.files.docs')).rules
    expect(folder.read).toEqual({ level: 'keys', from: 'projects.web.files.docs' })
    expect(folder.write).toEqual({ level: 'deny', from: 'adt.mcp.files' })
  })
})
