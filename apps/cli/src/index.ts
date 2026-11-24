#!/usr/bin/env node

import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { checkbox, confirm, password, select } from '@inquirer/prompts'
import { Command } from 'commander'
import { type AuthOptions, AuthSignInRequiredError, login, logout, openInBrowser, readAuthOptions } from '@appsys/devtool-auth'
import {
  createBackends,
  Environment,
  type EnvironmentBackend,
  type EnvironmentItem,
  type EnvironmentOptions,
  type EnvironmentSelection,
  listTables,
  mediaTypeOf,
  overwritesLocalData,
  parseTargets,
  readEnvironmentOptions,
  redisDatabaseName,
  SHARED_CONFIG_PATH,
  type TransferResult
} from '@appsys/devtool-environment'
import { CONFIG_FOLDER_VARIABLE, loadMergedConfig, resolveDefaultConfigPaths } from '@appsys/devtool-config'
import runProxy from '@appsys/devtool-proxy'
import runServer, { createBackendContext, relaunchUnderApp, renewCertificates } from '@appsys/devtool-server'
import { SKILLS_FOLDER } from '@appsys/devtool-skills'
import { logger, type LogLevel } from '@appsys/devtool-shared'
import pkg from '../package.json' with { type: 'json' }
import { agentSkillFolders, distinctFolders, foreignSkills, type SkillInstallMode, syncSkills, wasSynced } from './skills.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const UI_PATH = path.resolve(__dirname, '../../ui/dist')

/**
 * Reads the identity provider of the configuration of the devtool installation.
 * @returns The options.
 */
async function requireConfiguredAuth (): Promise<AuthOptions> {
  const { options, problems } = readAuthOptions((await loadMergedConfig()).config.auth)
  if (!options) {
    const details = problems.map(problem => `${problem.setting} ${problem.message}`).join('; ')
    throw new Error(`no complete \`auth\` section (type, issuer, clientId) in the devtool configuration${details ? `: ${details}` : ''}`)
  }
  return options
}

/** The environment of the configuration, connected to its backends. */
interface OpenedEnvironment {
  options: EnvironmentOptions
  backends: Map<string, EnvironmentBackend>
  environment: Environment
}

/**
 * Asks the developer for a secret in the terminal, such as the password of encrypted files.
 * @param label What the secret unlocks.
 * @returns The secret typed.
 */
async function askSecretInTerminal (label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(`${label} needs a password: run the command in a terminal, or give the password with a value block`)
  }
  return password({ message: `Password of ${label}`, mask: true })
}

/**
 * Connects the environment of the configuration to its backends, downloading the shared configuration
 * first from the default backend when the environment declares no item yet.
 * @param configPaths Paths of the configuration files.
 * @param bootstrap Whether to download the shared configuration when no item is declared.
 * @returns The environment; its backends must be closed once done.
 */
async function openEnvironment (configPaths: string[], bootstrap = true): Promise<OpenedEnvironment> {
  const { config } = await loadMergedConfig(configPaths)
  const options = readEnvironmentOptions(config.environment)
  if (!options || options.backends.length === 0 || options.defaultBackend === null) {
    throw new Error('no backend in environment.backends: declare one in config.local.yml, such as { team: { type: cdn, url } }')
  }
  const context = createBackendContext(config, askSecretInTerminal)
  const backends = createBackends(options.backends, context)
  const environment = new Environment(backends, options, context)
  if (!bootstrap || options.items.length > 0) {
    return { options, backends, environment }
  }

  try {
    const result = await environment.pull({ item: { kind: 'file', path: SHARED_CONFIG_PATH, backend: options.defaultBackend, encryption: null, ignore: null }, tables: null })
    if (!result.done) {
      throw new Error(`${SHARED_CONFIG_PATH} is not on ${options.defaultBackend}`)
    }
  } finally {
    await closeBackends(backends)
  }
  return openEnvironment(configPaths, false)
}

/**
 * Closes the connections of backends.
 * @param backends The backends.
 */
async function closeBackends (backends: Map<string, EnvironmentBackend>): Promise<void> {
  await Promise.all([...backends.values()].map(async backend => backend.close()))
}

/**
 * Runs a task on a backend of the environment, then closes the backends.
 * @param name The name of the backend, the default one when missing.
 * @param task Uses the backend.
 */
async function withBackend (name: string | undefined, task: (backend: EnvironmentBackend) => Promise<void>): Promise<void> {
  const { options, backends } = await openEnvironment(resolveDefaultConfigPaths(), false)
  try {
    const slug = name ?? options.defaultBackend!
    const backend = backends.get(slug)
    if (!backend) {
      throw new Error(`no backend named ${slug} in environment.backends (${[...backends.keys()].join(', ')})`)
    }
    await task(backend)
  } finally {
    await closeBackends(backends)
  }
}

/**
 * Signs the developer in with the identity provider in the browser.
 * @param options The settings of the identity provider.
 */
async function signIn (options: AuthOptions): Promise<void> {
  await login(options, url => {
    logger.info('CLI', 'Login', `Sign in${options.name ? ` with ${options.name}` : ''} on ${url}`)
    openInBrowser(url)
  })
  logger.info('CLI', 'Login', 'Signed in')
}

/**
 * Describes an item of the environment.
 * @param item The item.
 * @returns Its path and what it holds.
 */
function describeItem (item: EnvironmentItem): string {
  switch (item.kind) {
    case 'database':
      return `${item.path} (${item.engine} database of container ${item.container})`
    case 'bucket':
      return `${item.path} (bucket ${item.bucket})`
    case 'redis':
      return `${item.path} (Redis ${redisDatabaseName(item.url)})`
    default:
      return `${item.path} (file)`
  }
}

/**
 * Names a selection the way targets are written.
 * @param selection The selection.
 * @returns The target.
 */
function targetOf (selection: EnvironmentSelection): string {
  return selection.tables ? `${selection.item.path}:${selection.tables.join(',')}` : selection.item.path
}

/**
 * Asks which items, and which tables of the databases or key groups of the Redis databases, to transfer.
 * @param options The environment.
 * @param verb What is done with them.
 * @returns The selections.
 */
async function chooseSelections (options: EnvironmentOptions, verb: string): Promise<EnvironmentSelection[]> {
  const items = await checkbox({
    message: `Items to ${verb}`,
    choices: options.items.map(item => ({ name: describeItem(item), value: item })),
    required: true,
    pageSize: 15
  })

  const selections: EnvironmentSelection[] = []
  for (const item of items) {
    if (item.kind !== 'database' && item.kind !== 'redis') {
      selections.push({ item, tables: null })
      continue
    }

    const parts = item.kind === 'redis' ? 'key groups' : 'tables'
    const whole = await select({
      message: `${item.path}: whole database or some ${parts}?`,
      choices: [
        { name: 'Whole database', value: true },
        { name: `Some ${parts}`, value: false }
      ]
    })
    const tables = whole
      ? null
      : await checkbox({ message: `The ${parts} of ${item.path}`, choices: (await listTables(item)).map(table => ({ name: table, value: table })), required: true, pageSize: 20 })
    selections.push({ item, tables })
  }

  return selections
}

/**
 * Makes sure the developer accepts losing the local data a pull replaces.
 * @param selections The selections to pull.
 * @param yes Whether the developer already accepted.
 * @returns False when the developer declines.
 */
async function acceptOverwrite (selections: EnvironmentSelection[], yes: boolean): Promise<boolean> {
  const overwritten = selections.filter(overwritesLocalData).map(targetOf)
  if (overwritten.length === 0 || yes) {
    return true
  }

  if (!process.stdin.isTTY) {
    throw new Error(`pulling ${overwritten.join(', ')} replaces local data: pass --yes`)
  }

  return confirm({ message: `Replace the local data of ${overwritten.join(', ')}?`, default: false })
}

/**
 * Transfers selections one by one, reporting each, and fails at the end when one of them failed.
 * @param selections The selections.
 * @param run Transfers one selection.
 */
async function transfer (selections: EnvironmentSelection[], run: (selection: EnvironmentSelection) => Promise<TransferResult>): Promise<void> {
  let failures = 0
  for (const selection of selections) {
    try {
      const result = await run(selection)
      if (result.done) {
        logger.info('CLI', 'Env', `${targetOf(selection)}: ${result.detail}`)
      } else {
        logger.warn('CLI', 'Env', `${targetOf(selection)}: ${result.detail}`)
      }
    } catch (error) {
      if (error instanceof AuthSignInRequiredError) {
        throw error
      }

      failures += 1
      logger.error('CLI', 'Env', `${targetOf(selection)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} of ${selections.length} items failed`)
  }
}

/**
 * Pulls or pushes items of the environment, chosen by targets or interactively.
 * @param direction Whether the copies of the backends replace the local ones, or the reverse.
 * @param targets The targets, every item when empty.
 * @param flags Whether to choose interactively and whether local data may be replaced without asking.
 */
async function syncEnvironment (direction: 'pull' | 'push', targets: string[], flags: { interactive?: boolean, yes?: boolean }): Promise<void> {
  const { options, backends, environment } = await openEnvironment(resolveDefaultConfigPaths())
  try {
    const selections = flags.interactive ? await chooseSelections(options, direction) : parseTargets(options, targets)
    if (direction === 'push') {
      await transfer(selections, selection => environment.push(selection))
      return
    }

    if (!(await acceptOverwrite(selections, flags.yes === true))) {
      logger.warn('CLI', 'Env', 'Nothing pulled')
      return
    }

    await transfer(selections, selection => environment.pull(selection))
  } finally {
    await closeBackends(backends)
  }
}

/**
 * Installs the skills of the devtool in the skill folders of the agents, the folders, the mode and the
 * replacement of the skills of the user asked when not given and a terminal is there.
 * @param flags The folders and the mode given on the command line.
 * @param flags.target The folders.
 * @param flags.copy Copy the skills.
 * @param flags.link Link the skills.
 */
async function syncAgentSkills (flags: { target?: string[], copy?: boolean, link?: boolean }): Promise<void> {
  if (flags.copy && flags.link) {
    throw new Error('pass --copy or --link, not both')
  }
  const interactive = process.stdin.isTTY && !flags.target
  if (!interactive && !flags.target) {
    throw new Error('no terminal to choose the folders: pass --target <folders...>')
  }

  const known = agentSkillFolders()
  const folders = flags.target?.map(folder => path.resolve(folder)) ?? await checkbox({
    message: 'Skill folders to sync',
    choices: await Promise.all(known.map(async folder => ({
      name: `${folder.path.replace(os.homedir(), '~')}  (${folder.label})`,
      value: folder.path,
      checked: (await wasSynced(folder.path)) || (folder.global && (await fs.stat(folder.path).then(() => true, () => false)))
    }))),
    required: true
  })
  let mode: SkillInstallMode = flags.link ? 'link' : 'copy'
  if (interactive && !flags.copy && !flags.link) {
    mode = await select({
      message: 'How to put the skills',
      choices: [
        { name: 'Copy (kept if the devtool moves; sync again after an update)', value: 'copy' as const },
        { name: 'Link (always up to date; broken if the devtool is reinstalled elsewhere)', value: 'link' as const }
      ]
    })
  }

  for (const folder of await distinctFolders(folders)) {
    const replace: string[] = []
    for (const skill of await foreignSkills(SKILLS_FOLDER, folder)) {
      if (interactive && (await confirm({ message: `${folder} already has a ${skill} skill of its own: replace it?`, default: false }))) {
        replace.push(skill)
      }
    }
    const result = await syncSkills({ source: SKILLS_FOLDER, folder, mode, replace })
    const parts = (['added', 'updated', 'removed', 'unchanged'] as const).filter(kind => result[kind].length).map(kind => `${kind} ${result[kind].join(', ')}`)
    logger.info('CLI', 'Skills', `${folder.replace(os.homedir(), '~')}: ${parts.join('; ') || 'nothing to do'}`)
    if (result.skipped.length) {
      logger.warn('CLI', 'Skills', `${folder.replace(os.homedir(), '~')}: kept the skills of the same name you made: ${result.skipped.join(', ')}`)
    }
  }
}

function parsePort (input: string, label: string): number {
  const parsed = Number(input)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${input}`)
  }
  return parsed
}

function parseOptionalPort (input: string | undefined, label: string): number | undefined {
  if (typeof input !== 'string') {
    return undefined
  }
  return parsePort(input, label)
}

/**
 * Declares the commands of the devtool CLI and runs the one invoked.
 * @returns Resolves once the command ends.
 */
async function main (): Promise<void> {
  const program = new Command()

  program
    .name('devtool')
    .version(pkg.version)
    .option('--config-folder <folder>', `configuration folder, else $${CONFIG_FOLDER_VARIABLE}, else ~/.config/appsys/devtool`)
    .hook('preAction', () => {
      const folder = program.opts<{ configFolder?: string }>().configFolder
      if (folder) {
        const invocationCwd = process.env.INIT_CWD || process.cwd()
        process.env[CONFIG_FOLDER_VARIABLE] = folder.startsWith('~') ? folder : path.resolve(invocationCwd, folder)
      }
    })

  program
    .command('server [configurations...]')
    .description('Run Devtool server')
    .option('-s, --ssl <domain>', 'enable SSL for the domain given')
    .option('-g, --server-port <port>', 'server port')
    .option('-l, --load-balancer-port <port>', 'load balancer port')
    .option('--log-level <level>', 'set log level (error|warn|info|debug)', 'info')
    .action(async (configurations: string[], options: Record<string, string | undefined>) => {
      const invocationCwd = process.env.INIT_CWD?.length ? process.env.INIT_CWD : process.cwd()
      const configPaths = configurations.length
        ? configurations.map(configuration => (path.isAbsolute(configuration) ? configuration : path.resolve(invocationCwd, configuration)))
        : resolveDefaultConfigPaths()
      if (await relaunchUnderApp((await loadMergedConfig(configPaths)).config)) {
        return
      }
      logger.setLevel((options.logLevel ?? 'info') as LogLevel)

      await runServer({
        serverPort: parseOptionalPort(options.serverPort, 'server port'),
        loadBalancerPort: parseOptionalPort(options.loadBalancerPort, 'load balancer port'),
        ssl: options.ssl ?? null,
        uiPath: UI_PATH,
        configPaths
      })
    })

  program
    .command('proxy')
    .description('Create a TCP proxy to Devtool load-balancer')
    .option('-l, --load-balancer-port <port>', 'Devtool load-balancer port', '6731')
    .option('-p, --proxy-port <port>', 'proxy port', '443')
    .option('--log-level <level>', 'set log level (error|warn|info|debug)', 'info')
    .action((options: Record<string, string | undefined>) => {
      logger.setLevel((options.logLevel ?? 'info') as LogLevel)
      runProxy({
        adtSecurePort: parsePort(options.loadBalancerPort ?? '6731', 'load balancer port'),
        proxyPort: parsePort(options.proxyPort ?? '443', 'proxy port')
      })
    })

  program
    .command('login')
    .description('Sign in with the identity provider of the configuration')
    .action(async () => {
      await signIn(await requireConfiguredAuth())
    })

  program
    .command('logout')
    .description('Forget the session of the identity provider')
    .action(async () => {
      await logout()
      logger.info('CLI', 'Logout', 'Signed out')
    })

  const env = program
    .command('env')
    .description('Development environment (environment.folder), mirrored on its backends: configurations, databases, buckets, Redis databases')
    .addHelpText('after', '\nTargets: <path> for an item, <path>:<table>,<table> for tables of a database, <path>:<group>,<group> for key groups of a Redis database (such as account/redis.gz:session:*); every item without target.')

  const file = env.command('file').description('Any file of a backend, by hand')

  file
    .command('pull <path> [destination]')
    .description('Download a file; `-` as destination writes it to the standard output')
    .option('-b, --backend <name>', 'backend of environment.backends, the default one when omitted')
    .action(async (filePath: string, destination: string | undefined, flags: { backend?: string }) => {
      await withBackend(flags.backend, async backend => {
        const content = await backend.download(filePath)
        if (!content) {
          throw new Error(`no such file: ${filePath}`)
        }
        if (destination === '-') {
          await pipeline(content, process.stdout)
          return
        }

        const target = path.resolve(destination ?? path.basename(filePath))
        const partial = `${target}.part`
        try {
          await pipeline(content, createWriteStream(partial, { mode: 0o600 }))
          await fs.rename(partial, target)
        } finally {
          await fs.rm(partial, { force: true })
        }
        logger.info('CLI', 'Pull', `${filePath} -> ${target}`)
      })
    })

  file
    .command('push <path> <file>')
    .description('Upload a file, replacing the stored one')
    .option('-b, --backend <name>', 'backend of environment.backends, the default one when omitted')
    .option('-t, --type <mediaType>', 'media type of the file, guessed from its name when omitted')
    .action(async (filePath: string, localFile: string, flags: { backend?: string, type?: string }) => {
      await withBackend(flags.backend, async backend => {
        await backend.upload(filePath, path.resolve(localFile), flags.type ?? mediaTypeOf(filePath))
        logger.info('CLI', 'Push', `${localFile} -> ${filePath}`)
      })
    })

  file
    .command('rm <path>')
    .description('Delete a file')
    .option('-b, --backend <name>', 'backend of environment.backends, the default one when omitted')
    .action(async (filePath: string, flags: { backend?: string }) => {
      await withBackend(flags.backend, async backend => {
        await backend.remove(filePath)
        logger.info('CLI', 'Remove', filePath)
      })
    })

  env
    .command('pull [targets...]')
    .description('Replace local items, and the local data they hold, by the copies of their backends')
    .option('-i, --interactive', 'choose items, tables and key groups')
    .option('-y, --yes', 'replace local data without asking')
    .action(async (targets: string[], flags: { interactive?: boolean, yes?: boolean }) => {
      await syncEnvironment('pull', targets, flags)
    })

  env
    .command('push [targets...]')
    .description('Dump the local data of the items and send them to their backends')
    .option('-i, --interactive', 'choose items, tables and key groups')
    .action(async (targets: string[], flags: { interactive?: boolean }) => {
      await syncEnvironment('push', targets, flags)
    })

  program
    .command('cert')
    .description('Certificates of the load balancer')
    .command('renew [names...]')
    .description('Renew certificates declaring acme now, every one without name, and write them where they are served')
    .action(async (names: string[]) => {
      await renewCertificates(names)
    })

  program
    .command('skills')
    .description('Agent skills teaching coding agents to use the devtool')
    .command('sync')
    .description('Install or update the skills of the devtool in the skill folders of the agents, asked when no --target is given')
    .option('-t, --target <folders...>', 'skill folders of the agents to sync')
    .option('--copy', 'copy the skills (default without terminal)')
    .option('--link', 'link the skills to this installation of the devtool')
    .action(async (flags: { target?: string[], copy?: boolean, link?: boolean }) => {
      await syncAgentSkills(flags)
    })

  await program.parseAsync()
}

void main().catch(error => {
  logger.error('CLI', 'Main', error instanceof Error ? error.message : 'Unknown CLI error')
  process.exit(1)
})
