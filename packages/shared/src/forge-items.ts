import { replaceVariables } from './command-args.js'
import type { AgentAction, AgentDefinition, ForgeItemBase, ForgeItemsPayload, ForgeKind, IssuePayload, PullRequestPayload } from './types.js'

/** What agents may do with the items of each kind, in the order offered. */
export const AGENT_ACTIONS: Record<ForgeKind, readonly AgentAction[]> = {
  pullRequests: ['review'],
  issues: ['analyze', 'fix']
}

/** The prompt of each action of agents when neither the integration nor the devtool settings give one. */
export const DEFAULT_AGENT_PROMPTS: Record<AgentAction, string> = {
  review:
    'Review the pull request %{ADT:PR_URL} (#%{ADT:PR_NUMBER} "%{ADT:PR_TITLE}", %{ADT:PR_BRANCH} into %{ADT:PR_BASE}). '
    + 'Read its changes without checking out its branch, then list the problems you find by file and line, the most severe first.',
  analyze:
    'Analyze the issue %{ADT:ISSUE_URL} (#%{ADT:ISSUE_NUMBER} "%{ADT:ISSUE_TITLE}"). Read it and its comments, find the code involved, '
    + 'then explain the cause and propose a plan to solve it. Do not change any file.',
  fix:
    'Fix the issue %{ADT:ISSUE_URL} (#%{ADT:ISSUE_NUMBER} "%{ADT:ISSUE_TITLE}"). Read it and its comments, create a branch named after it, '
    + 'implement and test the fix, then summarize what changed.'
}

/** An item of a forge with its kind. */
export type ForgeEntry = { kind: 'pullRequests', item: PullRequestPayload } | { kind: 'issues', item: IssuePayload }

/**
 * Lists the items of an integration with their kind.
 * @param state The items of the integration.
 * @returns Each item with its kind, in order.
 */
export function forgeEntries (state: ForgeItemsPayload): ForgeEntry[] {
  return state.kind === 'pullRequests' ? state.items.map(item => ({ kind: 'pullRequests', item })) : state.items.map(item => ({ kind: 'issues', item }))
}

/**
 * Names an integration of a section or of one of its projects among those of the configuration.
 * @param section The slug of the section.
 * @param project The slug of the project declaring it, null for the section itself.
 * @param slug The slug of the integration.
 * @returns Its key, `<section>[/<project>]/<slug>`.
 */
export function integrationKey (section: string, project: string | null, slug: string): string {
  return project === null ? `${section}/${slug}` : `${section}/${project}/${slug}`
}

/**
 * Writes the prompt of an action of an agent on an item of a forge.
 * @param template The prompt: `%{ADT:PR_URL}`, `PR_NUMBER`, `PR_TITLE`, `PR_BRANCH`, `PR_BASE` and `PR_AUTHOR`
 * stand for a pull request, `%{ADT:ISSUE_URL}`, `ISSUE_NUMBER`, `ISSUE_TITLE` and `ISSUE_AUTHOR` for an issue.
 * @param entry The pull request or the issue.
 * @returns The prompt.
 */
export function agentPrompt (template: string, entry: ForgeEntry): string {
  if (entry.kind === 'pullRequests') {
    return replaceVariables(template, { ...itemValues('PR', entry.item), PR_BRANCH: entry.item.branch, PR_BASE: entry.item.base })
  }
  return replaceVariables(template, itemValues('ISSUE', entry.item))
}

/**
 * Gives the values of the variables every item of a forge has.
 * @param prefix The prefix of the variables of its kind.
 * @param item The item.
 * @returns The values, by variable name.
 */
function itemValues (prefix: string, item: ForgeItemBase): Record<string, string> {
  return {
    [`${prefix}_URL`]: item.url,
    [`${prefix}_NUMBER`]: String(item.number),
    [`${prefix}_TITLE`]: item.title,
    [`${prefix}_AUTHOR`]: item.author ?? ''
  }
}

/**
 * Builds the link starting an agent, its variables encoded.
 * @param agent The agent, started by a link.
 * @param prompt The prompt.
 * @param cwd The folder the agent works in.
 * @returns The link.
 */
export function agentUrl (agent: AgentDefinition, prompt: string, cwd: string): string {
  return replaceVariables(agent.url ?? '', { PROMPT: prompt, CWD: cwd }, encodeURIComponent)
}
