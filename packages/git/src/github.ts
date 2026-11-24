import type { ForgeKind, ForgeLabel, ForgeTimelinePage, PullRequestChecks, PullRequestReview } from '@appsys/devtool-shared'
import { ForgeError, type GitForge, requestJson } from './forge.js'
import {
  GITHUB_REVIEW_THREADS_QUERY,
  githubReviewThread,
  type GithubReviewThreadNode,
  githubTimelineEvent,
  type GithubTimelineNode,
  type GithubTimelinePage,
  githubTimelineQuery
} from './github-timeline.js'
import type { ForgeRepository } from './repository.js'

const ITEM_FIELDS = 'number title url body updatedAt author { login } labels(first: 20) { nodes { name color } }'

const PULL_REQUESTS_QUERY = `query ($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    items: pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        ${ITEM_FIELDS} isDraft headRefName baseRefName reviewDecision
        reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`

const ISSUES_QUERY = `query ($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    items: issues(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { ${ITEM_FIELDS} assignees(first: 20) { nodes { login } } comments { totalCount } }
    }
  }
}`

/** The most pages of 100 nodes of a list of an item read. */
const ITEM_PAGES = 10

/** A page of a list of GitHub. */
interface GithubConnection<T> {
  pageInfo: { hasNextPage: boolean, endCursor: string | null }
  nodes: T[]
}

/**
 * Reads every page of a list of a pull request or an issue, up to {@link ITEM_PAGES}.
 * @param repository The repository.
 * @param token The access token.
 * @param query The query of a page, reading the item as `item`, taking `$number` and the cursor `$after`.
 * @param number The number of the item.
 * @param field The list of the item the query reads.
 * @returns The nodes of the list, in order.
 */
async function readItemList<T> (repository: ForgeRepository, token: string | null, query: string, number: number, field: string): Promise<T[]> {
  const nodes: T[] = []
  let after: string | null = null
  for (let page = 0; page < ITEM_PAGES; page += 1) {
    const read: { repository: { item: Record<string, GithubConnection<T> | undefined> | null } } = await queryRepository(repository, token, query, { number, after })
    const list: GithubConnection<T> | undefined = read.repository.item?.[field]
    nodes.push(...(list?.nodes ?? []))
    if (!list?.pageInfo.hasNextPage) {
      break
    }
    after = list.pageInfo.endCursor
  }
  return nodes
}

/**
 * Reads a part of the timeline of a pull request or an issue from its end: its last events, or every
 * event before a cursor, up to {@link ITEM_PAGES} pages.
 * @param repository The repository.
 * @param token The access token.
 * @param kind Whether the item is a pull request or an issue.
 * @param number The number of the item.
 * @param page The last events, or every event before a cursor.
 * @returns The items, the oldest first, the cursor of those before them and about how many they are.
 */
async function readTimeline (repository: ForgeRepository, token: string | null, kind: ForgeKind, number: number, page: ForgeTimelinePage): Promise<{ nodes: GithubTimelineNode[], before: string | null, remaining: number }> {
  const query = githubTimelineQuery(kind)
  const last = 'last' in page ? page.last : 100
  let before = 'before' in page ? page.before : null
  let nodes: GithubTimelineNode[] = []
  let total = 0
  for (let read = 0; read < ITEM_PAGES; read += 1) {
    const answer: { repository: { item: { timelineItems?: GithubTimelinePage } | null } } = await queryRepository(repository, token, query, { number, last, before })
    const list: GithubTimelinePage | undefined = answer.repository.item?.timelineItems
    nodes = [...(list?.nodes ?? []), ...nodes]
    total = list?.totalCount ?? 0
    before = list?.pageInfo.hasPreviousPage ? list.pageInfo.startCursor : null
    if ('last' in page || !before) {
      break
    }
  }
  return { nodes, before, remaining: before ? Math.max(total - nodes.length, 1) : 0 }
}

const CHECKS: Record<string, PullRequestChecks> = { SUCCESS: 'success', PENDING: 'pending', EXPECTED: 'pending', FAILURE: 'failure', ERROR: 'failure' }

const REVIEWS: Record<string, PullRequestReview> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changesRequested', REVIEW_REQUIRED: 'required' }

interface GithubItem {
  number: number
  title: string
  url: string
  body: string
  updatedAt: string
  author: { login: string } | null
  labels: { nodes: { name: string, color: string }[] } | null
}

interface GithubPullRequest extends GithubItem {
  isDraft: boolean
  headRefName: string
  baseRefName: string
  reviewDecision: string | null
  reviewRequests: { nodes: { requestedReviewer: { login?: string } | null }[] }
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
}

interface GithubIssue extends GithubItem {
  assignees: { nodes: { login: string }[] }
  comments: { totalCount: number }
}

/**
 * Sends a GraphQL query about a repository to GitHub, or to GitHub Enterprise Server.
 * @param repository The repository, `<owner>/<name>`.
 * @param token The access token.
 * @param query The query, taking `$owner` and `$name`.
 * @param variables Its other variables.
 * @returns The username of the token and the repository as the query reads it.
 * @throws {ForgeError} Without token, for a path GitHub does not hold, or when GitHub refuses or fails.
 */
async function queryRepository<T> (repository: ForgeRepository, token: string | null, query: string, variables: Record<string, unknown> = {}): Promise<{ viewer: string, repository: T }> {
  if (!token) {
    throw new ForgeError(401, 'GitHub needs a token')
  }
  const [owner, name, ...rest] = repository.path.split('/')
  if (rest.length) {
    throw new ForgeError(400, `GitHub repositories are <owner>/<name>, not ${repository.path}`)
  }

  const endpoint = repository.host === 'github.com' ? 'https://api.github.com/graphql' : `${new URL(repository.webUrl).origin}/api/graphql`
  const answer = await requestJson<{ data?: { viewer: { login: string }, repository: T | null }, errors?: { message: string }[] }>('GitHub', endpoint, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { owner, name, ...variables } })
  })
  if (answer.errors?.length || !answer.data?.repository) {
    throw new ForgeError(200, `GitHub: ${answer.errors?.map(error => error.message).join(', ') || `no repository ${repository.path}`}`)
  }
  return { viewer: answer.data.viewer.login, repository: answer.data.repository }
}

/**
 * Reads what every item of GitHub has.
 * @param item The pull request or the issue.
 * @param viewer The username of the token.
 * @returns Its number, title, link, author, description, labels, last change and whether the person wrote it.
 */
function baseOf (item: GithubItem, viewer: string) {
  return {
    number: item.number,
    title: item.title,
    url: item.url,
    author: item.author?.login ?? null,
    body: item.body,
    labels: (item.labels?.nodes ?? []).map((label): ForgeLabel => ({ name: label.name, color: `#${label.color}` })),
    updatedAt: item.updatedAt,
    mine: item.author?.login === viewer
  }
}

/** GitHub and GitHub Enterprise Server, read through their GraphQL API. */
export const github: GitForge = {
  name: 'github',
  label: 'GitHub',
  icon: 'simple-icons:github',

  matches (host) {
    return host === 'github.com' || host.startsWith('github.')
  },

  async pullRequests (repository, token) {
    const { viewer, repository: read } = await queryRepository<{ items: { nodes: GithubPullRequest[] } }>(repository, token, PULL_REQUESTS_QUERY)
    return {
      viewer,
      items: read.items.nodes.map(pullRequest => {
        const checks = pullRequest.commits.nodes[0]?.commit.statusCheckRollup?.state
        return {
          ...baseOf(pullRequest, viewer),
          branch: pullRequest.headRefName,
          base: pullRequest.baseRefName,
          draft: pullRequest.isDraft,
          checks: checks ? (CHECKS[checks] ?? null) : null,
          review: pullRequest.reviewDecision ? (REVIEWS[pullRequest.reviewDecision] ?? null) : null,
          reviewRequested: pullRequest.reviewRequests.nodes.some(request => request.requestedReviewer?.login === viewer)
        }
      })
    }
  },

  async issues (repository, token) {
    const { viewer, repository: read } = await queryRepository<{ items: { nodes: GithubIssue[] } }>(repository, token, ISSUES_QUERY)
    return {
      viewer,
      items: read.items.nodes.map(issue => {
        const assignees = issue.assignees.nodes.map(assignee => assignee.login)
        return { ...baseOf(issue, viewer), assignees, comments: issue.comments.totalCount, assigned: assignees.includes(viewer) }
      })
    }
  },

  async timeline (repository, token, kind, number, page) {
    const [timeline, threadNodes] = await Promise.all([
      readTimeline(repository, token, kind, number, page),
      kind === 'pullRequests' ? readItemList<GithubReviewThreadNode>(repository, token, GITHUB_REVIEW_THREADS_QUERY, number, 'reviewThreads') : Promise.resolve([])
    ])
    const threads = new Map(threadNodes.flatMap(node => {
      const thread = githubReviewThread(node)
      return thread ? [thread] : []
    }))
    return { events: timeline.nodes.flatMap(node => githubTimelineEvent(node, threads) ?? []), before: timeline.before, remaining: timeline.remaining }
  }
}
