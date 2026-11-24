import type { Component } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import { CircleDot, GitPullRequest, Search, Sparkles, Wrench } from '@lucide/vue'
import type { AgentAction, AgentDefinition, ForgeEntry, ForgeKind, IntegrationDefinition } from '@appsys/devtool-shared'
import { agentPrompt, DEFAULT_AGENT_PROMPTS } from '@appsys/devtool-shared'
import { type AgentPlace, startAgent } from '@/lib/agents'

/** How the interface shows an action of agents: its name, its icon, and whether its button shows the icon alone. */
export const AGENT_ACTION_VIEWS: Record<AgentAction, { label: string, icon: Component, compact: boolean }> = {
  review: { label: 'Review', icon: Sparkles, compact: false },
  analyze: { label: 'Analyze', icon: Search, compact: true },
  fix: { label: 'Fix', icon: Wrench, compact: true }
}

/** A tab of the list of the items of a kind. */
export interface ForgeFilter {
  value: string
  label: string
  keep: (entry: ForgeEntry) => boolean
}

/** The tabs of the list of each kind, the first showing every item. */
export const FORGE_FILTERS: Record<ForgeKind, ForgeFilter[]> = {
  pullRequests: [
    { value: 'open', label: 'Open', keep: () => true },
    { value: 'review', label: 'Review requested', keep: entry => entry.kind === 'pullRequests' && entry.item.reviewRequested },
    { value: 'mine', label: 'Mine', keep: entry => entry.item.mine }
  ],
  issues: [
    { value: 'open', label: 'Open', keep: () => true },
    { value: 'assigned', label: 'Assigned', keep: entry => entry.kind === 'issues' && entry.item.assigned },
    { value: 'mine', label: 'Mine', keep: entry => entry.item.mine }
  ]
}

/** The icon of an open item of each kind. */
export const FORGE_ICONS: Record<ForgeKind, Component> = { pullRequests: GitPullRequest, issues: CircleDot }

/**
 * Gives the page of an item of an integration.
 * @param place The section or project declaring the integration.
 * @param integration The slug of the integration.
 * @param number The number of the item.
 * @returns The route of its page.
 */
export function forgeItemRoute (place: AgentPlace, integration: string, number: number): RouteLocationRaw {
  const params = { projectSlug: place.projectSlug, integration, number: String(number) }
  return place.directorySlug ? { name: 'directory-integration-item', params: { ...params, directorySlug: place.directorySlug } } : { name: 'project-integration-item', params }
}

/**
 * Starts an action of an agent on an item of an integration, with the prompt of the integration.
 * @param integration The integration listing the item.
 * @param place Where the agent works.
 * @param entry The item.
 * @param action What the agent does.
 * @param agent The agent.
 */
export function startForgeAction (integration: IntegrationDefinition, place: AgentPlace, entry: ForgeEntry, action: AgentAction, agent: AgentDefinition): void {
  const prompt = agentPrompt(integration.agentPrompts[action] ?? DEFAULT_AGENT_PROMPTS[action], entry)
  startAgent(agent, place, prompt, `${AGENT_ACTION_VIEWS[action].label} #${entry.item.number}`)
}
