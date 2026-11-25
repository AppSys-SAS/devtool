import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { SHARED_CONFIG_PATH } from '@appsys-sas/devtool-environment'
import { environmentRules, type ForgeKind, integrationKey, logger, MCP_LEVELS, type McpAction, type McpRule, type McpRules } from '@appsys-sas/devtool-shared'
import { z } from 'zod'
import { maskValues } from './files.js'
import type { McpHost } from './host.js'
import { type McpCall, defineTool, McpToolError, type McpTool } from './tool.js'

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])
const PORT_CHECK_MS = 300

/**
 * Tells whether a port of this machine accepts connections.
 * @param port The port.
 * @returns True when something listens on it.
 */
function isListening (port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: PORT_CHECK_MS })
    const done = (listening: boolean): void => {
      socket.destroy()
      resolve(listening)
    }
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * Describes where a service sends its requests and whether each target of this machine listens.
 * @param targets The URLs of the targets.
 * @returns Each target, with whether it listens when it is on this machine.
 */
async function describeTargets (targets: string[]): Promise<{ url: string, listening: boolean | null }[]> {
  return Promise.all(
    targets.map(async target => {
      const url = new URL(target)
      const local = LOCAL_HOSTNAMES.has(url.hostname) && url.port
      return { url: target, listening: local ? await isListening(Number(url.port)) : null }
    })
  )
}

/**
 * Lists the items of one kind of the integrations of the sections and projects an agent may read, as
 * last read, asking a person once for all the integrations whose rule asks.
 * @param host The server.
 * @param kind The pull requests or the issues.
 * @param call The call of the tool.
 * @returns For each integration, where it is declared, its repository and its items.
 */
async function listForgeItems (host: McpHost, kind: ForgeKind, call: McpCall) {
  const label = kind === 'pullRequests' ? 'pull requests' : 'issues'
  const listed = Object.values(host.config.projects).flatMap(section =>
    [{ slug: null, integrations: section.integrations }, ...Object.values(section.directories)].flatMap(owner =>
      owner.integrations
        .filter(integration => integration.type === kind && integration.mcp?.read.level !== 'deny')
        .map(integration => ({ section: section.slug, project: owner.slug, integration }))
    )
  )
  const asked = listed.flatMap(({ integration }) => (integration.mcp?.read.level === 'ask' ? [{ name: integration.name, rule: integration.mcp.read }] : []))
  if (asked.length > 0) {
    await call.authorize({
      action: 'read',
      rule: asked[0].rule,
      title: `See the ${label} of ${asked.map(({ name }) => name).join(', ')}`,
      grantKey: `read:${kind}`,
      grantLabel: `See the ${label}`
    })
  }

  const states = new Map(host.forgeItems.state().map(state => [state.key, state]))
  return listed.map(({ section, project, integration }) => {
    const state = states.get(integrationKey(section, project, integration.slug))
    return {
      section,
      project,
      integration: integration.slug,
      repository: integration.url,
      forge: integration.provider?.label ?? null,
      viewer: state?.viewer ?? null,
      updatedAt: state?.updatedAt ?? null,
      error: state?.error ?? null,
      [kind]: state?.items ?? []
    }
  })
}

/**
 * Gives the rules of a certificate of the load balancer.
 * @param host The server.
 * @param name The name of the certificate.
 * @returns Its rules, the default ones when it is unknown.
 */
function certificateRules (host: McpHost, name: string): McpRules {
  return host.config.loadBalancers[`.${name}`]?.mcp ?? host.config.adt.mcp.certificates
}

/**
 * Gives the rule of an action on items of the environment: the strictest of their rules.
 * @param host The server.
 * @param action The action.
 * @param paths The paths of the items.
 * @returns The rule deciding the action.
 */
function environmentRule (host: McpHost, action: McpAction, paths: string[]): McpRule {
  return paths
    .map(itemPath => environmentRules(host.config.adt.mcp, itemPath)[action])
    .reduce((strictest, rule) => (MCP_LEVELS.indexOf(rule.level) > MCP_LEVELS.indexOf(strictest.level) ? rule : strictest))
}

/**
 * Gives the tools of the projects, the environment, the certificates and the messages to the user.
 * @param host The server.
 * @returns The tools.
 */
export function environmentTools (host: McpHost): McpTool[] {
  return [
    defineTool({
      name: 'list_projects',
      title: 'List sections and projects',
      description:
        'Lists the sections and projects of the devtool: folders, missing folders and their restore, services of the load balancer (hosts, URLs, targets and whether they listen), file spaces, plus the integrations, DNS records and configuration warnings.',
      input: { section: z.string().optional().describe('Only this section') },
      readOnly: true,
      run: async ({ section }) => {
        const { config } = host
        const lbPort = config.adt.ports.loadBalancer
        const sections = await Promise.all(
          Object.values(config.projects)
            .filter(item => (!section || item.slug === section) && item.mcp.read.level !== 'deny')
            .map(async item => ({
              section: item.slug,
              name: item.name,
              path: item.path,
              missing: item.missing,
              restore: item.restore?.name ?? null,
              projects: await Promise.all(
                Object.values(item.directories)
                  .filter(project => project.mcp.read.level !== 'deny')
                  .map(async project => ({
                    project: project.slug,
                    name: project.name,
                    description: project.description ?? null,
                    path: project.path,
                    missing: project.missing,
                    restore: project.restore?.name ?? null,
                    services: await Promise.all(
                      Object.values(project.loadBalancer).map(async rule => ({
                        service: rule.slug,
                        urls: rule.hosts.map(name => `https://${name}${lbPort === 443 ? '' : `:${lbPort}`}${rule.prefix ?? ''}`),
                        targets: await describeTargets(rule.targets)
                      }))
                    ),
                    files: Object.keys(project.files).map(slug => `${item.slug}/${project.slug}/${slug}`)
                  }))
              )
            }))
        )
        return {
          sections,
          integrations: config.integrations.map(integration => ({ name: integration.name, url: integration.url })),
          dns: config.dns?.records ?? [],
          warnings: config.warnings
        }
      }
    }),
    defineTool({
      name: 'port_owners',
      title: 'Find who holds a port',
      description: 'Lists the processes listening on a port of this machine.',
      input: { port: z.number().int().min(1).max(65535) },
      readOnly: true,
      run: async ({ port }, call) => {
        call.describe(`port ${port}`)
        await call.authorize({ action: 'read', rule: host.config.adt.mcp.devtool.read, title: `See who holds port ${port}`, grantKey: 'read:ports', grantLabel: 'See the holders of ports' })
        return { port, owners: await host.portOwners(port) }
      }
    }),
    defineTool({
      name: 'reload_config',
      title: 'Reload the configuration',
      description: 'Reads the configuration of the devtool again, as its reload button does.',
      input: {},
      run: async (_input, call) => {
        call.describe('configuration')
        await call.authorize({ action: 'control', rule: host.config.adt.mcp.devtool.control, title: 'Reload the configuration', grantKey: 'control:config', grantLabel: 'Reload the configuration' })
        await host.reconfigure()
        return { warnings: host.config.warnings }
      }
    }),
    defineTool({
      name: 'environment_status',
      title: 'Environment status',
      description: 'Describes the environment synchronized with its backends: its files, databases, buckets and Redis databases, the backend of each, their local copies and the copies of their backends, and the pull or push running.',
      input: {},
      readOnly: true,
      run: async (_input, call) => {
        call.describe('environment')
        await call.authorize({ action: 'read', rule: host.config.adt.mcp.environment.read, keysOnly: true, title: 'See the environment', grantKey: 'read:environment', grantLabel: 'See the environment' })
        const state = host.environment.state()
        return { ...state, items: state.items.filter(item => environmentRule(host, 'read', [item.path]).level !== 'deny') }
      }
    }),
    defineTool({
      name: 'environment_keys',
      title: 'Compare keys of an environment file',
      description: 'Lists the keys whose values differ between the local copy of a configuration file of the environment and the copy of its backend; values are replaced by their type where only keys may be read.',
      input: { path: z.string().describe('Path of the file in the environment') },
      readOnly: true,
      run: async ({ path }, call) => {
        const rule = environmentRule(host, 'read', [path])
        call.describe(`environment:${path}`)
        await call.authorize({ action: 'read', rule, keysOnly: true, title: `Compare the keys of ${path}`, grantKey: `read:environment:${path}`, grantLabel: `See ${path}` })
        const keys = await host.environment.keys(path)
        if (rule.level !== 'keys') {
          return keys
        }
        return {
          ...keys,
          entries: keys.entries.map(entry => ({
            path: entry.path,
            local: { present: entry.local.present, value: maskValues(entry.local.value) },
            remote: { present: entry.remote.present, value: maskValues(entry.remote.value) }
          }))
        }
      }
    }),
    defineTool({
      name: 'environment_tables',
      title: 'List tables of an environment database',
      description: 'Lists the tables of a local database of the environment, or the key groups of a Redis database.',
      input: { path: z.string().describe('Path of the database in the environment') },
      readOnly: true,
      run: async ({ path }, call) => {
        call.describe(`environment:${path}`)
        await call.authorize({ action: 'read', rule: environmentRule(host, 'read', [path]), title: `List the tables of ${path}`, grantKey: `read:environment:${path}`, grantLabel: `See ${path}` })
        return host.environment.tables(path)
      }
    }),
    defineTool({
      name: 'environment_sync',
      title: 'Pull or push the environment',
      description:
        'Starts a pull (the copies of the backends replace the local ones) or a push (the reverse) of items of the environment, optionally restricted to tables. A push is always confirmed by the user. Follow it with environment_status.',
      input: {
        direction: z.enum(['pull', 'push']),
        targets: z
          .array(z.object({ path: z.string(), tables: z.array(z.string()).optional().describe('Only these tables of a database') }))
          .min(1)
      },
      run: async ({ direction, targets }, call) => {
        if (host.environment.state().run?.finished === false) {
          throw new McpToolError('A pull or push is already running')
        }
        const paths = targets.map(target => target.path)
        const items = host.environment.state().items
        const refused = paths.filter(path => items.find(item => item.path === path)?.allowed[direction] === false)
        if (refused.length > 0) {
          throw new McpToolError(`The groups of the user do not let them ${direction} ${refused.join(', ')}`)
        }
        call.describe(`environment ${direction}`)
        await call.authorize({
          action: 'run',
          rule: environmentRule(host, 'run', paths),
          confirm: direction === 'push',
          title: `${direction === 'pull' ? 'Pull' : 'Push'} ${paths.join(', ')}`,
          details: targets.map(target => ({ label: direction, value: target.tables?.length ? `${target.path} (${target.tables.join(', ')})` : target.path })),
          grantKey: `run:environment:pull:${paths.join(',')}`,
          grantLabel: `Pull ${paths.join(', ')}`
        })
        host.environment.run(direction, targets.map(target => ({ path: target.path, tables: target.tables ?? null }))).catch((error: unknown) => {
          logger.warn('MCP', 'Environment', error instanceof Error ? error.message : String(error))
        })
        return { started: direction, targets: paths }
      }
    }),
    defineTool({
      name: 'pull_shared_config',
      title: 'Pull the shared configuration',
      description: 'Replaces the shared configuration of the devtool by the copy of the default backend, then reloads it. Always confirmed by the user.',
      input: {},
      run: async (_input, call) => {
        call.describe('shared configuration')
        await call.authorize({ action: 'run', rule: environmentRule(host, 'run', [SHARED_CONFIG_PATH]), confirm: true, title: 'Pull the shared configuration of the devtool from the default backend' })
        const pulled = await host.environment.pullSharedConfig()
        if (!pulled) {
          throw new McpToolError(host.environment.state().error ?? 'The shared configuration was not pulled')
        }
        await host.reconfigure()
        return { pulled, warnings: host.config.warnings }
      }
    }),
    defineTool({
      name: 'list_certificates',
      title: 'List certificates',
      description: 'Lists the certificates of the load balancer: expiry, issuer, error, how they renew and whether a renewal runs.',
      input: {},
      readOnly: true,
      run: () => host.certificates.state().filter(certificate => certificateRules(host, certificate.name).read.level !== 'deny')
    }),
    defineTool({
      name: 'renew_certificate',
      title: 'Renew a certificate',
      description: 'Renews a certificate of the load balancer now, in a terminal.',
      input: { name: z.string().describe('Name of the certificate, from list_certificates') },
      run: async ({ name }, call) => {
        const certificate = host.certificates.state().find(item => item.name === name)
        if (!certificate?.trigger) {
          throw new McpToolError(`${name} is not a certificate renewed by the devtool`)
        }
        call.describe(`certificate ${name}`)
        await call.authorize({ action: 'run', rule: certificateRules(host, name).run, title: `Renew the certificate ${name}`, grantKey: `run:certificate:${name}`, grantLabel: `Renew ${name}` })
        await host.certificates.renew(name, null)
        return host.certificates.state().find(item => item.name === name)
      }
    }),
    defineTool({
      name: 'list_pull_requests',
      title: 'List pull requests',
      description:
        'Lists the open pull requests of the repositories of the sections (project null) and projects, as last read from their forge: number, title, link, author, description, labels, branches, draft, checks, review, whether a review of the user is requested and whether the user wrote it.',
      input: {},
      readOnly: true,
      run: (_input, call) => listForgeItems(host, 'pullRequests', call)
    }),
    defineTool({
      name: 'list_issues',
      title: 'List issues',
      description:
        'Lists the open issues of the repositories of the sections (project null) and projects, as last read from their forge: number, title, link, author, description, labels, assignees, number of comments, whether it is assigned to the user and whether the user wrote it.',
      input: {},
      readOnly: true,
      run: (_input, call) => listForgeItems(host, 'issues', call)
    }),
    defineTool({
      name: 'notify_user',
      title: 'Notify the user',
      description: 'Shows a message to the user in the devtool interface, and as a notification when they are enabled.',
      input: {
        message: z.string().min(1).max(500),
        level: z.enum(['info', 'warning', 'error']).optional()
      },
      run: async ({ message, level }, call) => {
        call.describe('message')
        await host.notifyUser({ id: randomUUID(), client: call.client, message, level: level ?? 'info', date: Date.now() })
        return { shown: true }
      }
    })
  ]
}
