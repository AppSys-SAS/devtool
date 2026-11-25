import { setTimeout as delay } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'
import {
  commandInputs,
  defaultCommandInputs,
  expandCommandArgs,
  MCP_ACTIONS,
  missingCommandInputs,
  type CommandInputValue,
  type DirectoryDefinition,
  type DirectoryExtra,
  type McpAction,
  type McpDetail,
  type McpRule,
  type ProjectDefinition,
  type RuntimeConfig
} from '@appsys-sas/devtool-shared'
import { z } from 'zod'
import { patternRule } from './approvals.js'
import type { McpHost, McpTerminal } from './host.js'
import { defineTool, McpToolError, type McpCall, type McpTool } from './tool.js'

/** The bytes a named key sends to a terminal. */
const KEYS = {
  'enter': '\r',
  'tab': '\t',
  'esc': '\u001b',
  'backspace': '\u007f',
  'up': '\u001b[A',
  'down': '\u001b[B',
  'right': '\u001b[C',
  'left': '\u001b[D',
  'ctrl-c': '\u0003',
  'ctrl-d': '\u0004',
  'ctrl-z': '\u001a',
  'ctrl-l': '\u000c'
} as const
const KEY_NAMES = Object.keys(KEYS) as [keyof typeof KEYS, ...(keyof typeof KEYS)[]]
const SCREEN_DELAY_MS = 300
const MAX_WAIT_SECONDS = 300
const DEFAULT_LINES = 200

const waitSchema = z
  .object({
    pattern: z.string().optional().describe('Regular expression awaited in the new output'),
    exit: z.boolean().optional().describe('Wait for the process to end'),
    timeout: z.number().int().min(1).max(MAX_WAIT_SECONDS).optional().describe('Seconds, 60 by default')
  })
  .optional()
  .describe('Waits after starting, for a pattern or the end of the process')

/** A command of the configuration and what holds it. */
export interface McpCommandTarget {
  /** `<section>/<project>/<slug>`. */
  id: string
  section: ProjectDefinition
  project: DirectoryDefinition
  command: DirectoryExtra
  /** Whether it is the main command of its project. */
  main: boolean
}

/**
 * Names a command of the configuration for agents.
 * @param section The slug of its section.
 * @param project The slug of its project.
 * @param slug Its slug, the path of a script.
 * @returns `<section>/<project>/<slug>`.
 */
export function commandIdOf (section: string, project: string, slug: string): string {
  return `${section}/${project}/${slug}`
}

/**
 * Lists the commands and scripts of the configuration, those of missing folders left out.
 * @param config The configuration.
 * @returns The commands, in the order of the configuration.
 */
export function allCommands (config: RuntimeConfig): McpCommandTarget[] {
  return Object.values(config.projects).flatMap(section =>
    Object.values(section.directories)
      .filter(project => !project.missing)
      .flatMap(project => {
        const main = project.defaultAction?.shortcut.type === 'command' ? project.defaultAction.shortcut.slug : null
        return Object.values(project.extras).map(command => ({ id: commandIdOf(section.slug, project.slug, command.slug), section, project, command, main: command.slug === main }))
      })
  )
}

/**
 * Finds a command of the configuration by its identifier.
 * @param config The configuration.
 * @param id `<section>/<project>/<slug>`.
 * @returns The command.
 * @throws {McpToolError} When there is none.
 */
export function findCommand (config: RuntimeConfig, id: string): McpCommandTarget {
  const target = allCommands(config).find(item => item.id === id)
  if (!target) {
    throw new McpToolError(`No command ${id}; list_commands gives the identifiers`)
  }
  return target
}

/**
 * Gives the rule of an action on a terminal: the terminals an agent started itself follow
 * `ownTerminals` for typing and control, those of a command its rules, the main terminal of a project
 * its rules, any other terminal the rules of the terminals a person opened.
 * @param config The configuration.
 * @param stream The terminal.
 * @param action The action.
 * @param client The agent acting, null when it does not matter.
 * @returns The rule.
 */
export function terminalRule (config: RuntimeConfig, stream: McpTerminal, action: McpAction, client: string | null = null): McpRule {
  if (stream.origin !== null && stream.origin === client && (action === 'input' || action === 'control')) {
    return { level: config.adt.mcp.ownTerminals, from: 'adt.mcp.ownTerminals' }
  }
  const project = stream.projectSlug && stream.directorySlug ? config.projects[stream.projectSlug]?.directories[stream.directorySlug] : undefined
  const command = stream.command ? project?.extras[stream.command] : undefined
  return (command?.mcp ?? (stream.primary ? project?.mcp : undefined) ?? config.adt.mcp.terminals)[action]
}

/**
 * Gives the identifier of the command a terminal runs.
 * @param stream The terminal.
 * @returns `<section>/<project>/<slug>`, null for any other command.
 */
function commandIdOfStream (stream: McpTerminal): string | null {
  return stream.command && stream.projectSlug && stream.directorySlug ? commandIdOf(stream.projectSlug, stream.directorySlug, stream.command) : null
}

/**
 * Lists the terminals an agent may see.
 * @param host The server.
 * @returns The terminals.
 */
export function readableTerminals (host: McpHost): McpTerminal[] {
  return host.streams.filter(stream => terminalRule(host.config, stream, 'read').level !== 'deny')
}

/**
 * Describes a terminal for an agent.
 * @param stream The terminal.
 * @returns Its state.
 */
export function describeTerminal (stream: McpTerminal): Record<string, unknown> {
  return {
    terminal: stream.slug,
    name: stream.name,
    command: commandIdOfStream(stream),
    section: stream.projectSlug,
    project: stream.directorySlug,
    startedBy: stream.origin ?? 'user',
    running: stream.running,
    exitCode: stream.exitCode,
    cwd: stream.cwd,
    args: stream.runningArgs ?? stream.args,
    portConflict: stream.portConflict,
    cursor: stream.outputStart + stream.output.length
  }
}

/**
 * Gives the output of a terminal as plain lines, colors and cursor moves removed, a line rewritten
 * with carriage returns kept as last written.
 * @param stream The terminal.
 * @param since The cursor to read from, the oldest output kept when absent.
 * @param lines The number of last lines kept.
 * @param grep A regular expression the lines kept must match.
 * @param info Whether the messages of the devtool itself, such as the command started, are kept.
 * @returns The lines, the cursor of the end of the output and whether older output was dropped.
 */
export function terminalLog (stream: McpTerminal, since: number | undefined, lines: number, grep?: string, info = true): { text: string, cursor: number, truncated: boolean } {
  const start = stream.outputStart
  const from = Math.max(since ?? start, start)
  const text = stripVTControlCharacters(
    stream.output
      .slice(from - start)
      .filter(line => info || line.type !== 'info')
      .map(line => line.content)
      .join('')
  )
  let rows = text.split(/\r?\n/).map(row => row.split('\r').filter(Boolean).at(-1) ?? '')
  if (grep) {
    const regex = new RegExp(grep, 'i')
    rows = rows.filter(row => regex.test(row))
  }
  return { text: rows.slice(-lines).join('\n'), cursor: start + stream.output.length, truncated: since !== undefined && since < start }
}

/**
 * Finds a terminal by its slug.
 * @param host The server.
 * @param slug The slug of the terminal.
 * @returns The terminal.
 * @throws {McpToolError} When there is none.
 */
function findTerminal (host: McpHost, slug: string): McpTerminal {
  const stream = host.streams.find(item => item.slug === slug)
  if (!stream) {
    throw new McpToolError(`No terminal ${slug}; list_terminals gives the terminals`)
  }
  return stream
}

/**
 * Names what an action on a terminal grants: its command, else the terminal itself for the session.
 * @param stream The terminal.
 * @param action The action.
 * @returns The key and whether the grant may outlive the session.
 */
function terminalGrant (stream: McpTerminal, action: McpAction): { grantKey: string, durable: boolean } {
  const id = commandIdOfStream(stream)
  return id ? { grantKey: `${action}:${id}`, durable: true } : { grantKey: `${action}:terminal:${stream.slug}`, durable: false }
}

/**
 * Decides an action on a terminal, asking a person when its rule says so.
 * @param host The server.
 * @param call The call.
 * @param stream The terminal.
 * @param action The action.
 * @param title Describes the call to a person.
 * @param details What the call does.
 * @param keys The named keys pressed.
 */
async function authorizeTerminal (host: McpHost, call: McpCall, stream: McpTerminal, action: McpAction, title: string, details: McpDetail[] = [], keys: string[] = []): Promise<void> {
  call.describe(stream.name, stream.slug)
  const grant = terminalGrant(stream, action)
  await call.authorize({
    action,
    rule: terminalRule(host.config, stream, action, call.client),
    title,
    details: [{ label: 'Terminal', value: `${stream.name} (${stream.slug})` }, { label: 'Folder', value: stream.cwd }, ...details],
    keys,
    grantKey: grant.grantKey,
    grantLabel: `${action} ${commandIdOfStream(stream) ?? stream.name}`,
    durable: grant.durable
  })
}

/**
 * Waits for a pattern in the output of a terminal after a cursor, or for the end of its process.
 * @param stream The terminal.
 * @param options What to wait for.
 * @param options.pattern A regular expression awaited in the output.
 * @param options.exit Whether the end of the process ends the wait; true when no pattern is given.
 * @param options.timeout Seconds before giving up.
 * @param since The cursor the output is read from.
 * @returns Why the wait ended, the output read and the cursor of its end.
 */
function waitForOutput (stream: McpTerminal, options: { pattern?: string, exit?: boolean, timeout?: number }, since: number): Promise<Record<string, unknown>> {
  const regex = options.pattern ? new RegExp(options.pattern, 'm') : null
  const exit = options.exit ?? !regex
  return new Promise(resolve => {
    const finish = (status: 'matched' | 'exited' | 'closed' | 'timeout'): void => {
      clearTimeout(timer)
      stream.events.off('output', check)
      stream.events.off('update', check)
      stream.events.off('close', closed)
      const { text, cursor } = terminalLog(stream, since, DEFAULT_LINES)
      resolve({ status, exitCode: stream.exitCode, running: stream.running, cursor, output: text })
    }
    const check = (): void => {
      if (regex?.test(terminalLog(stream, since, Number.MAX_SAFE_INTEGER, undefined, false).text)) {
        finish('matched')
      } else if (exit && !stream.running) {
        finish('exited')
      }
    }
    const closed = (): void => finish('closed')
    const timer = setTimeout(() => finish('timeout'), (options.timeout ?? 60) * 1000)
    stream.events.on('output', check)
    stream.events.on('update', check)
    stream.events.on('close', closed)
    check()
  })
}

/**
 * Describes a terminal just started, once the wait asked for is over, so that its state is the one
 * after the wait.
 * @param stream The terminal.
 * @param wait What to wait for, absent to describe it at once.
 * @param wait.pattern A regular expression awaited in the output.
 * @param wait.exit Whether the end of the process ends the wait.
 * @param wait.timeout Seconds before giving up.
 * @returns The state of the terminal, with the result of the wait.
 */
async function describeStarted (stream: McpTerminal, wait?: { pattern?: string, exit?: boolean, timeout?: number }): Promise<Record<string, unknown>> {
  const waited = wait ? await waitForOutput(stream, wait, stream.outputStart) : null
  return { ...describeTerminal(stream), ...(waited ? { wait: waited } : {}) }
}

/**
 * Starts a command of the configuration as the sidebar does: the main command of a project in its
 * main terminal, started again when it exists, any other command in a new terminal.
 * @param host The server.
 * @param target The command.
 * @param inputs The values of its inputs.
 * @param origin The agent starting it.
 * @returns The terminal, null for a command running outside of any terminal.
 */
async function startCommand (host: McpHost, target: McpCommandTarget, inputs: CommandInputValue[], origin: string): Promise<McpTerminal | null> {
  const { section, project, command, main } = target
  if (main) {
    const existing = host.streams.find(stream => stream.projectSlug === section.slug && stream.directorySlug === project.slug && stream.primary)
    if (existing) {
      if (!existing.running) {
        await existing.update({ action: 'start' })
      }
      return existing
    }
  }
  const data = {
    projectSlug: section.slug,
    directorySlug: project.slug,
    primary: main,
    args: [],
    env: command.env,
    shell: command.shell,
    killSignal: command.killSignal,
    name: main ? project.name : command.name,
    notifications: command.notifications,
    options: { command: command.slug, inputs, origin }
  }
  if (command.detached) {
    await host.newCommandDetached(data)
    return null
  }
  return host.newCommandStream(data)
}

/**
 * Describes a command of the configuration for agents.
 * @param host The server.
 * @param target The command.
 * @returns What an agent needs to run it.
 */
function describeCommand (host: McpHost, target: McpCommandTarget): Record<string, unknown> {
  const { command } = target
  const terminal = host.streams.find(stream => commandIdOfStream(stream) === target.id && stream.running)
  return {
    id: target.id,
    kind: command.script ? 'script' : 'command',
    name: command.name,
    main: target.main,
    summary: command.script?.summary ?? null,
    usage: command.script?.usage ?? null,
    detached: command.detached,
    inputs: commandInputs(command.args).map(input => ({
      name: input.name,
      kind: input.kind,
      choices: input.choices.map(choice => choice.value),
      optional: input.optional,
      default: input.default
    })),
    runningTerminal: terminal?.slug ?? null,
    levels: Object.fromEntries(MCP_ACTIONS.map(action => [action, command.mcp[action].level]))
  }
}

/**
 * Finds the folder of a section or of one of its projects.
 * @param config The configuration.
 * @param location `<section>` or `<section>/<project>`.
 * @returns The section, the project and the folder.
 * @throws {McpToolError} When there is none.
 */
function findFolder (config: RuntimeConfig, location: string): { section: ProjectDefinition, project: DirectoryDefinition | null, path: string } {
  const [sectionSlug, projectSlug] = location.split('/', 2)
  const section = config.projects[sectionSlug]
  const project = projectSlug ? section?.directories[projectSlug] : null
  if (!section || project === undefined || section.missing || project?.missing) {
    throw new McpToolError(`No folder ${location}; list_projects gives the sections and projects`)
  }
  return { section, project, path: project?.path ?? section.path }
}

/**
 * Gives the tools of the terminals, commands, scripts and sections.
 * @param host The server.
 * @returns The tools.
 */
export function terminalTools (host: McpHost): McpTool[] {
  return [
    defineTool({
      name: 'list_commands',
      title: 'List commands and scripts',
      description: 'Lists the commands and scripts declared in the devtool configuration, with their inputs, their running terminal and the level of each action (read, run, input, control) for agents.',
      input: { section: z.string().optional().describe('Only the commands of this section') },
      readOnly: true,
      run: ({ section }) =>
        allCommands(host.config)
          .filter(target => (!section || target.section.slug === section) && target.command.mcp.read.level !== 'deny')
          .map(target => describeCommand(host, target))
    }),
    defineTool({
      name: 'list_terminals',
      title: 'List terminals',
      description: 'Lists the terminals of the devtool: who started them, their command, whether they run, their exit code and the cursor of the end of their output.',
      input: {},
      readOnly: true,
      run: () => readableTerminals(host).map(describeTerminal)
    }),
    defineTool({
      name: 'read_terminal',
      title: 'Read a terminal',
      description:
        'Reads a terminal. `log` gives the output as plain text (pass the returned cursor as `since` next time to read only what is new); `screen` gives the visible screen, for interactive prompts and full-screen programs.',
      input: {
        terminal: z.string().describe('Slug of the terminal'),
        mode: z.enum(['log', 'screen']).optional().describe('log by default'),
        since: z.number().int().min(0).optional().describe('Cursor returned by an earlier read'),
        lines: z.number().int().min(1).max(5000).optional().describe(`Last lines kept, ${DEFAULT_LINES} by default`),
        grep: z.string().optional().describe('Regular expression the lines kept must match')
      },
      readOnly: true,
      run: async ({ terminal, mode, since, lines, grep }, call) => {
        const stream = findTerminal(host, terminal)
        await authorizeTerminal(host, call, stream, 'read', `Read ${stream.name}`)
        if (mode === 'screen') {
          return { ...describeTerminal(stream), screen: await stream.screen() }
        }
        return { ...describeTerminal(stream), ...terminalLog(stream, since, lines ?? DEFAULT_LINES, grep) }
      }
    }),
    defineTool({
      name: 'wait_for_output',
      title: 'Wait for a terminal',
      description: 'Waits until the output of a terminal matches a regular expression, or its process ends, then gives the output read.',
      input: {
        terminal: z.string().describe('Slug of the terminal'),
        pattern: z.string().optional().describe('Regular expression awaited in the output'),
        exit: z.boolean().optional().describe('Wait for the end of the process, the default without pattern'),
        since: z.number().int().min(0).optional().describe('Cursor the output is read from, the current end by default'),
        timeout: z.number().int().min(1).max(MAX_WAIT_SECONDS).optional().describe('Seconds, 60 by default')
      },
      readOnly: true,
      run: async ({ terminal, pattern, exit, since, timeout }, call) => {
        const stream = findTerminal(host, terminal)
        await authorizeTerminal(host, call, stream, 'read', `Read ${stream.name}`)
        return waitForOutput(stream, { pattern, exit, timeout }, since ?? stream.outputStart + stream.output.length)
      }
    }),
    defineTool({
      name: 'search_terminals',
      title: 'Search terminals',
      description: 'Searches a regular expression in the output of every terminal the agent may read, such as an error.',
      input: {
        pattern: z.string().describe('Regular expression, case insensitive'),
        lines: z.number().int().min(1).max(500).optional().describe('Last matching lines kept per terminal, 20 by default')
      },
      readOnly: true,
      run: ({ pattern, lines }) =>
        readableTerminals(host)
          .filter(stream => terminalRule(host.config, stream, 'read').level === 'allow')
          .map(stream => ({ terminal: stream.slug, name: stream.name, ...terminalLog(stream, undefined, lines ?? 20, pattern) }))
          .filter(result => result.text.length > 0)
    }),
    defineTool({
      name: 'run_command',
      title: 'Run a command or script',
      description:
        'Runs a command or script of the configuration by its identifier from list_commands, its inputs given by name (defaults otherwise). The main command of a project restarts in its own terminal. Returns the terminal, and its output when `wait` is given.',
      input: {
        command: z.string().describe('Identifier `<section>/<project>/<slug>`'),
        inputs: z.record(z.string(), z.union([z.string(), z.boolean()])).optional().describe('Values of the inputs by name'),
        wait: waitSchema
      },
      run: async ({ command, inputs, wait }, call) => {
        const target = findCommand(host.config, command)
        const definitions = commandInputs(target.command.args)
        const unknown = Object.keys(inputs ?? {}).filter(name => !definitions.some(input => input.name === name))
        if (unknown.length) {
          throw new McpToolError(`Unknown inputs ${unknown.join(', ')}; inputs of ${command}: ${definitions.map(input => input.name).join(', ') || 'none'}`)
        }
        const proposed = definitions.map((input, index) => inputs?.[input.name] ?? defaultCommandInputs(target.command.args)[index])
        call.describe(command)
        const authorization = await call.authorize({
          action: 'run',
          rule: target.command.mcp.run,
          title: `Run ${target.command.name}`,
          details: [
            { label: 'Command', value: command },
            ...(target.command.script?.summary ? [{ label: 'Summary', value: target.command.script.summary }] : []),
            ...(target.command.script?.usage ? [{ label: 'Usage', value: target.command.script.usage }] : []),
            { label: 'Command line', value: expandCommandArgs(target.command.args, proposed).join(' ') },
            { label: 'Folder', value: target.project.path }
          ],
          command: definitions.length ? command : null,
          inputs: definitions.length ? proposed : null,
          grantKey: `run:${command}`,
          grantLabel: `Run ${command}`
        })
        const values = authorization.inputs ?? proposed
        const missing = missingCommandInputs(target.command.args, values)
        if (missing.length) {
          throw new McpToolError(`No value for ${missing.join(', ')}`)
        }
        const stream = await startCommand(host, target, values, call.client)
        if (!stream) {
          return { detached: true, command }
        }
        call.describe(command, stream.slug)
        return describeStarted(stream, wait)
      }
    }),
    defineTool({
      name: 'run_shell',
      title: 'Run a shell command',
      description: 'Runs a command line, outside the commands of the configuration, in a new terminal of a section or project folder. Allowed by the adt.mcp.shell patterns of the configuration.',
      input: {
        command: z.string().min(1).describe('The command line, run by the shell'),
        cwd: z.string().describe('Folder: `<section>` or `<section>/<project>`'),
        wait: waitSchema
      },
      run: async ({ command, cwd, wait }, call) => {
        const folder = findFolder(host.config, cwd)
        call.describe(command)
        await call.authorize({
          action: 'run',
          rule: patternRule(host.config.adt.mcp.shell, command, 'adt.mcp.shell'),
          title: `Run ${command}`,
          details: [
            { label: 'Command line', value: command },
            { label: 'Folder', value: folder.path }
          ],
          grantKey: `shell:${command}`,
          grantLabel: `Run ${command}`
        })
        const shell = host.config.adt.shell ?? process.env.SHELL ?? '/bin/sh'
        const stream = await host.newCommandStream({
          projectSlug: folder.section.slug,
          directorySlug: folder.project?.slug ?? null,
          args: [shell, '-c', command],
          name: command,
          notifications: false,
          options: { cwd: folder.path, origin: call.client }
        })
        call.describe(command, stream.slug)
        return describeStarted(stream, wait)
      }
    }),
    defineTool({
      name: 'send_input',
      title: 'Type into a terminal',
      description: 'Types text and presses keys in a running terminal, then gives its screen.',
      input: {
        terminal: z.string().describe('Slug of the terminal'),
        text: z.string().optional().describe('Text typed as is'),
        keys: z.array(z.enum(KEY_NAMES)).optional().describe('Keys pressed after the text, in order')
      },
      run: async ({ terminal, text, keys }, call) => {
        const stream = findTerminal(host, terminal)
        if (!text && !keys?.length) {
          throw new McpToolError('Nothing to type: give text or keys')
        }
        await authorizeTerminal(host, call, stream, 'input', `Type into ${stream.name}`, text ? [{ label: 'Text', value: text }] : [], keys ?? [])
        if (!stream.running) {
          throw new McpToolError(`${stream.name} is not running`)
        }
        stream.writeInput(`${text ?? ''}${(keys ?? []).map(key => KEYS[key]).join('')}`)
        await delay(SCREEN_DELAY_MS)
        return { ...describeTerminal(stream), screen: await stream.screen() }
      }
    }),
    defineTool({
      name: 'control_terminal',
      title: 'Start, stop, restart or close a terminal',
      description: 'Starts again, stops, restarts or closes a terminal (closing stops it first).',
      input: {
        terminal: z.string().describe('Slug of the terminal'),
        action: z.enum(['start', 'stop', 'restart', 'close'])
      },
      run: async ({ terminal, action }, call) => {
        const stream = findTerminal(host, terminal)
        await authorizeTerminal(host, call, stream, action === 'start' ? 'run' : 'control', `${action[0].toUpperCase()}${action.slice(1)} ${stream.name}`)
        if (action === 'close' && stream.running) {
          await stream.update({ action: 'stop' })
        }
        await stream.update({ action })
        return action === 'close' ? { terminal, closed: true } : describeTerminal(stream)
      }
    }),
    defineTool({
      name: 'resize_terminal',
      title: 'Resize a terminal',
      description: 'Changes the size of a terminal, for programs drawing on the whole screen. The interface may resize it again to fit its window.',
      input: {
        terminal: z.string().describe('Slug of the terminal'),
        cols: z.number().int().min(20).max(500),
        rows: z.number().int().min(5).max(200)
      },
      run: async ({ terminal, cols, rows }, call) => {
        const stream = findTerminal(host, terminal)
        await authorizeTerminal(host, call, stream, 'control', `Resize ${stream.name} to ${cols}x${rows}`)
        stream.resize(cols, rows)
        return { ...describeTerminal(stream), size: stream.size }
      }
    }),
    defineTool({
      name: 'resolve_port_conflict',
      title: 'Resolve a port conflict',
      description: 'For a terminal whose command could not use its port: stops the processes holding it, stops them and restarts the command, or forgets the conflict.',
      input: {
        terminal: z.string().describe('Slug of the terminal'),
        action: z.enum(['kill', 'killAndRestart', 'dismiss'])
      },
      run: async ({ terminal, action }, call) => {
        const stream = findTerminal(host, terminal)
        const conflict = stream.portConflict
        if (!conflict) {
          throw new McpToolError(`${stream.name} has no port conflict`)
        }
        await authorizeTerminal(host, call, stream, 'control', `${action} the holders of port ${conflict.port}`, [
          { label: 'Port', value: String(conflict.port) },
          { label: 'Processes', value: conflict.owners.map(owner => `${owner.pid} ${owner.command}`).join('\n') }
        ])
        await stream.resolvePortConflict(action)
        return describeTerminal(stream)
      }
    }),
    defineTool({
      name: 'start_section',
      title: 'Start a section',
      description: 'Starts the commands of a section declaring startWithSection that are not running, with their default inputs, as the start button of the section does.',
      input: { section: z.string().describe('Slug of the section') },
      run: async ({ section }, call) => {
        const targets = allCommands(host.config).filter(
          target =>
            target.section.slug === section
            && target.command.startWithSection
            && !host.streams.some(stream => stream.running && stream.projectSlug === section && stream.directorySlug === target.project.slug && (target.main ? stream.primary : !stream.primary && stream.command === target.command.slug))
        )
        return runGroup(call, `Start section ${section}`, 'run', `run:section:${section}`, targets.map(target => ({ name: target.id, rule: target.command.mcp.run })), async index => {
          const target = targets[index]
          const inputs = defaultCommandInputs(target.command.args)
          if (missingCommandInputs(target.command.args, inputs).length) {
            return 'needs inputs: use run_command'
          }
          return (await startCommand(host, target, inputs, call.client))?.slug ?? 'detached'
        })
      }
    }),
    defineTool({
      name: 'stop_section',
      title: 'Stop a section',
      description: 'Stops every running terminal of a section, as the stop button of the section does.',
      input: { section: z.string().describe('Slug of the section') },
      run: async ({ section }, call) => {
        const streams = host.streams.filter(stream => stream.projectSlug === section && stream.running)
        return runGroup(call, `Stop section ${section}`, 'control', `control:section:${section}`, streams.map(stream => ({ name: stream.name, rule: terminalRule(host.config, stream, 'control', call.client) })), async index => {
          await streams[index].update({ action: 'stop' })
          return 'stopped'
        })
      }
    }),
    defineTool({
      name: 'restore_folder',
      title: 'Restore a missing folder',
      description: 'Runs the restore command of a missing section or project (such as a clone), then reloads the configuration once it ends.',
      input: {
        section: z.string().describe('Slug of the section'),
        project: z.string().optional().describe('Slug of the missing project, absent for the section itself')
      },
      run: async ({ section, project }, call) => {
        const sectionDefinition = host.config.projects[section]
        const target = project ? sectionDefinition?.directories[project] : sectionDefinition
        if (!target?.missing || !target.restore) {
          throw new McpToolError(`${project ? `${section}/${project}` : section} is not a missing folder with a restore command`)
        }
        const restore = target.restore
        call.describe(project ? `${section}/${project}` : section)
        await call.authorize({
          action: 'run',
          rule: target.restoreRule,
          title: `${restore.name} ${target.name}`,
          details: [
            { label: 'Folder', value: target.path },
            { label: 'Command line', value: restore.args.join(' ') }
          ],
          grantKey: `run:restore:${section}/${project ?? ''}`,
          grantLabel: `Restore ${target.name}`
        })
        const stream = await host.newCommandStream(
          { projectSlug: section, directorySlug: project ?? null, args: restore.args, name: `${restore.name} ${target.name}`, notifications: true, options: { restore: true, origin: call.client } },
          { onExit: () => void host.reconfigure() }
        )
        call.describe(target.name, stream.slug)
        return describeTerminal(stream)
      }
    })
  ]
}

/**
 * Acts on several things at once: those the configuration refuses are skipped, those it asks for are
 * asked together in one request, then every other one is acted on.
 * @param call The call.
 * @param title Describes the call to a person, and what an answer for the session or always grants.
 * @param action The action.
 * @param grantKey Names what an answer for the session or always grants.
 * @param items What is acted on, by name, with its rule.
 * @param act Acts on one of them, by its index.
 * @returns What happened to each.
 */
async function runGroup (
  call: McpCall,
  title: string,
  action: McpAction,
  grantKey: string,
  items: { name: string, rule: McpRule }[],
  act: (index: number) => Promise<string>
): Promise<Record<string, string>> {
  call.describe(title)
  const asked = items.filter(item => item.rule.level === 'ask')
  if (asked.length) {
    await call.authorize({
      action,
      rule: { level: 'ask', from: asked.map(item => item.rule.from).join(', ') },
      title,
      details: asked.map(item => ({ label: action, value: item.name })),
      grantKey,
      grantLabel: title
    })
  }
  const results: Record<string, string> = {}
  for (const [index, item] of items.entries()) {
    results[item.name] = item.rule.level === 'deny' ? `skipped: refused by ${item.rule.from}` : await act(index)
  }
  return results
}
