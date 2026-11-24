import type { ForgeKind, ForgeReviewState, ForgeReviewThread, ForgeTimelineEvent } from '@appsys/devtool-shared'

const SHARED_EVENTS = `
  ... on IssueComment { author { login } body createdAt }
  ... on LabeledEvent { actor { login } createdAt label { name color } }
  ... on UnlabeledEvent { actor { login } createdAt label { name color } }
  ... on AssignedEvent { actor { login } createdAt assignee { ... on User { login } } }
  ... on UnassignedEvent { actor { login } createdAt assignee { ... on User { login } } }
  ... on ClosedEvent { actor { login } createdAt }
  ... on ReopenedEvent { actor { login } createdAt }
  ... on RenamedTitleEvent { actor { login } createdAt previousTitle currentTitle }
  ... on CrossReferencedEvent { actor { login } createdAt source { ... on Issue { number title } ... on PullRequest { number title } } }`

const PULL_REQUEST_EVENTS = `
  ... on PullRequestReview { author { login } body state createdAt comments(first: 100) { nodes { id } } }
  ... on PullRequestCommit { commit { abbreviatedOid messageHeadline committedDate author { name user { login } } } }
  ... on MergedEvent { actor { login } createdAt mergeRefName commit { abbreviatedOid } }
  ... on HeadRefForcePushedEvent { actor { login } createdAt beforeCommit { abbreviatedOid } afterCommit { abbreviatedOid } }
  ... on ReviewRequestedEvent { actor { login } createdAt requestedReviewer { ... on User { login } ... on Team { name } } }
  ... on ReadyForReviewEvent { actor { login } createdAt }
  ... on ConvertToDraftEvent { actor { login } createdAt }`

/**
 * Writes the query reading one page of the timeline of a pull request or an issue, from its end.
 * @param kind Whether the item is a pull request or an issue.
 * @returns The query, taking `$owner`, `$name`, `$number`, the size `$last` and the cursor `$before`.
 */
export function githubTimelineQuery (kind: ForgeKind): string {
  const type = kind === 'pullRequests' ? 'PullRequest' : 'Issue'
  const events = kind === 'pullRequests' ? SHARED_EVENTS + PULL_REQUEST_EVENTS : SHARED_EVENTS
  return `query ($owner: String!, $name: String!, $number: Int!, $last: Int!, $before: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    item: issueOrPullRequest(number: $number) {
      ... on ${type} { timelineItems(last: $last, before: $before) { totalCount pageInfo { hasPreviousPage startCursor } nodes { __typename ${events} } } }
    }
  }
}`
}

/** A page of a timeline of GitHub, read from its end. */
export interface GithubTimelinePage {
  totalCount: number
  pageInfo: { hasPreviousPage: boolean, startCursor: string | null }
  nodes: GithubTimelineNode[]
}

/** The query reading one page of the discussions about the code of a pull request, taking `$owner`, `$name`, `$number` and the cursor `$after`. */
export const GITHUB_REVIEW_THREADS_QUERY = `query ($owner: String!, $name: String!, $number: Int!, $after: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    item: pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved isOutdated path line originalLine
          comments(first: 100) { nodes { id author { login } body createdAt diffHunk } }
        }
      }
    }
  }
}`

/** A discussion about the code of a pull request of GitHub. */
export interface GithubReviewThreadNode {
  isResolved: boolean
  isOutdated: boolean
  path: string
  line: number | null
  originalLine: number | null
  comments: { nodes: { id: string, author: { login: string } | null, body: string, createdAt: string, diffHunk: string | null }[] }
}

/**
 * Turns a discussion about the code of GitHub into a thread of the devtool, named by its first comment.
 * @param node The discussion.
 * @returns The identifier of its first comment and the thread, null for a discussion without comment.
 */
export function githubReviewThread (node: GithubReviewThreadNode): [string, ForgeReviewThread] | null {
  const [first] = node.comments.nodes
  if (!first) {
    return null
  }
  return [
    first.id,
    {
      path: node.path,
      line: node.line ?? node.originalLine,
      diffHunk: first.diffHunk,
      resolved: node.isResolved,
      outdated: node.isOutdated,
      comments: node.comments.nodes.map(comment => ({ author: comment.author?.login ?? null, body: comment.body, createdAt: comment.createdAt }))
    }
  ]
}

/** An item of a timeline of GitHub, the fields of its type only. */
export interface GithubTimelineNode {
  __typename: string
  author?: { login: string } | null
  actor?: { login: string } | null
  createdAt?: string
  body?: string
  state?: string
  label?: { name: string, color: string }
  assignee?: { login?: string } | null
  previousTitle?: string
  currentTitle?: string
  source?: { number?: number, title?: string } | null
  comments?: { nodes: { id: string }[] }
  commit?: { abbreviatedOid: string, messageHeadline?: string, committedDate?: string, author?: { name: string | null, user: { login: string } | null } | null }
  mergeRefName?: string
  beforeCommit?: { abbreviatedOid: string } | null
  afterCommit?: { abbreviatedOid: string } | null
  requestedReviewer?: { login?: string, name?: string } | null
}

const REVIEW_STATES: Record<string, ForgeReviewState> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changesRequested', COMMENTED: 'commented', DISMISSED: 'dismissed' }

/**
 * Turns an item of a timeline of GitHub into an event of the devtool.
 * @param node The item.
 * @param threads The discussions about the code, by the identifier of their first comment.
 * @returns The event, null for a type the devtool does not show or a review without content, such as
 * one only answering a discussion, shown in that discussion.
 */
export function githubTimelineEvent (node: GithubTimelineNode, threads: ReadonlyMap<string, ForgeReviewThread>): ForgeTimelineEvent | null {
  const author = node.actor?.login ?? node.author?.login ?? null
  const createdAt = node.createdAt ?? ''
  const event = (kind: Extract<ForgeTimelineEvent, { type: 'event' }>['kind'], text: string): ForgeTimelineEvent => ({ type: 'event', author, createdAt, kind, text, label: null })

  switch (node.__typename) {
    case 'IssueComment':
      return { type: 'comment', author, createdAt, body: node.body ?? '' }
    case 'PullRequestReview': {
      const state = REVIEW_STATES[node.state ?? '']
      const reviewThreads = (node.comments?.nodes ?? []).flatMap(comment => threads.get(comment.id) ?? [])
      return state && (state !== 'commented' || node.body || reviewThreads.length) ? { type: 'review', author, createdAt, state, body: node.body ?? '', threads: reviewThreads } : null
    }
    case 'PullRequestCommit':
      return node.commit
        ? { type: 'commit', author: node.commit.author?.user?.login ?? node.commit.author?.name ?? null, createdAt: node.commit.committedDate ?? '', sha: node.commit.abbreviatedOid, message: node.commit.messageHeadline ?? '' }
        : null
    case 'LabeledEvent':
    case 'UnlabeledEvent':
      return node.label
        ? { type: 'event', author, createdAt, kind: 'label', text: node.__typename === 'LabeledEvent' ? 'added the label' : 'removed the label', label: { name: node.label.name, color: `#${node.label.color}` } }
        : null
    case 'AssignedEvent':
      return event('assign', `assigned ${node.assignee?.login ?? 'someone'}`)
    case 'UnassignedEvent':
      return event('assign', `unassigned ${node.assignee?.login ?? 'someone'}`)
    case 'ReviewRequestedEvent':
      return event('reviewRequest', `requested a review from ${node.requestedReviewer?.login ?? node.requestedReviewer?.name ?? 'someone'}`)
    case 'MergedEvent':
      return event('merge', `merged commit ${node.commit?.abbreviatedOid ?? ''} into ${node.mergeRefName ?? ''}`)
    case 'ClosedEvent':
      return event('close', 'closed this')
    case 'ReopenedEvent':
      return event('reopen', 'reopened this')
    case 'HeadRefForcePushedEvent':
      return event('push', `force-pushed from ${node.beforeCommit?.abbreviatedOid ?? '?'} to ${node.afterCommit?.abbreviatedOid ?? '?'}`)
    case 'RenamedTitleEvent':
      return event('rename', `changed the title from "${node.previousTitle ?? ''}" to "${node.currentTitle ?? ''}"`)
    case 'CrossReferencedEvent':
      return event('reference', `mentioned this in #${node.source?.number ?? '?'} ${node.source?.title ?? ''}`.trim())
    case 'ReadyForReviewEvent':
      return event('draft', 'marked this as ready for review')
    case 'ConvertToDraftEvent':
      return event('draft', 'marked this as a draft')
    default:
      return null
  }
}
