import type { IntegrationDefinition, McpLevel, McpRules } from '@appsys-sas/devtool-shared'
import { describe, expect, it, vi } from 'vitest'
import type { McpPermission } from '../../src/approvals.js'
import { environmentTools } from '../../src/environment.js'
import type { McpHost } from '../../src/host.js'
import type { McpCall } from '../../src/tool.js'

/**
 * Builds the rules of an integration reading at one level.
 * @param level The level of reading its items.
 * @returns The rules.
 */
function rulesAt (level: McpLevel): McpRules {
  return { read: { level, from: 'test' } } as McpRules
}

/**
 * Builds an integration listing pull requests.
 * @param slug Its slug.
 * @param level The level of reading its items.
 * @returns The integration.
 */
function pulls (slug: string, level: McpLevel): IntegrationDefinition {
  return {
    slug,
    name: `Pulls ${slug}`,
    type: 'pullRequests',
    icon: 'lucide:git-pull-request',
    url: `https://github.com/example/${slug}`,
    embed: false,
    provider: { name: 'github', label: 'GitHub' },
    agentActions: [],
    agentPrompts: {},
    badge: true,
    refresh: 5,
    mcp: rulesAt(level),
    mcpTarget: { path: ['sections', 'main', 'integrations', slug, 'mcp'], declaredIn: null }
  }
}

/**
 * Lists the pull requests of a section holding integrations.
 * @param integrations The integrations of the section.
 * @returns The integrations listed and the permissions asked.
 */
async function listPullRequests (integrations: IntegrationDefinition[]): Promise<{ listed: string[], asked: McpPermission[] }> {
  const host = {
    config: { projects: { main: { slug: 'main', integrations, directories: {} } } },
    forgeItems: { state: () => [] }
  } as unknown as McpHost
  const asked: McpPermission[] = []
  const call: McpCall = {
    session: 'session',
    client: 'test',
    authorize: vi.fn(async (permission: McpPermission) => {
      asked.push(permission)
      return { decision: 'allow' as const, inputs: null }
    }),
    describe: () => undefined
  } as unknown as McpCall
  const tool = environmentTools(host).find(candidate => candidate.name === 'list_pull_requests')
  const result = (await tool?.run({}, call)) as { integration: string }[]
  return { listed: result.map(item => item.integration), asked }
}

describe('list_pull_requests', () => {
  it('lists the integrations agents may read, without asking', async () => {
    expect(await listPullRequests([pulls('api', 'allow'), pulls('web', 'allow')])).toEqual({ listed: ['api', 'web'], asked: [] })
  })

  it('leaves out the integrations kept from agents', async () => {
    expect((await listPullRequests([pulls('api', 'allow'), pulls('web', 'deny')])).listed).toEqual(['api'])
  })

  it('asks once for all the integrations whose rule asks', async () => {
    const { listed, asked } = await listPullRequests([pulls('api', 'ask'), pulls('web', 'ask'), pulls('ops', 'allow')])

    expect(listed).toEqual(['api', 'web', 'ops'])
    expect(asked).toEqual([expect.objectContaining({ action: 'read', title: 'See the pull requests of Pulls api, Pulls web', grantKey: 'read:pullRequests' })])
  })
})
