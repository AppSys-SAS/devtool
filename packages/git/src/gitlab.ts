import type { ForgeEventKind, ForgeLabel, ForgeReviewThread, ForgeTimelineEvent, PullRequestReview } from '@appsys-sas/devtool-shared'
import { type ForgeItems, type GitForge, requestJson } from './forge.js'
import type { ForgeRepository } from './repository.js'

const REVIEWS: Record<string, PullRequestReview> = { requested_changes: 'changesRequested', not_approved: 'required' }

const LIST_QUERY = 'state=opened&per_page=50&order_by=updated_at&sort=desc&with_labels_details=true'

interface GitlabItem {
  iid: number
  title: string
  web_url: string
  description: string | null
  updated_at: string
  author: { username: string } | null
  labels: { name: string, color: string | null }[] | null
}

interface GitlabMergeRequest extends GitlabItem {
  draft: boolean
  source_branch: string
  target_branch: string
  detailed_merge_status: string | null
  reviewers: { username: string }[] | null
}

interface GitlabIssue extends GitlabItem {
  assignees: { username: string }[] | null
  user_notes_count: number
}

interface GitlabNote {
  author: { username: string } | null
  body: string
  created_at: string
  system: boolean
  /** `DiffNote` for a note about lines of the code. */
  type: string | null
  position?: { new_path: string | null, old_path: string | null, new_line: number | null, old_line: number | null } | null
  resolved?: boolean
}

interface GitlabDiscussion {
  notes: GitlabNote[]
}

/** The most pages of 100 discussions of a timeline read. */
const TIMELINE_PAGES = 10

/** What a system note is about, by the start of its text. */
const SYSTEM_NOTE_KINDS: [RegExp, ForgeEventKind][] = [
  [/label/, 'label'],
  [/^(un)?assigned/, 'assign'],
  [/requested review/, 'reviewRequest'],
  [/^merged/, 'merge'],
  [/^closed/, 'close'],
  [/^reopened/, 'reopen'],
  [/^(added \d+ commits?|force-pushed)/, 'push'],
  [/^changed title/, 'rename'],
  [/^mentioned in/, 'reference'],
  [/draft|ready/, 'draft']
]

/**
 * Turns a note of GitLab into an event of a timeline: a comment, or the change a system note tells.
 * @param note The note.
 * @returns The event.
 */
function noteEvent (note: GitlabNote): ForgeTimelineEvent {
  const author = note.author?.username ?? null
  if (!note.system) {
    return { type: 'comment', author, createdAt: note.created_at, body: note.body }
  }
  const text = (note.body.split('\n')[0] ?? '').replace(/<[^>]+>/g, '').replaceAll('**', '').trim()
  const kind = SYSTEM_NOTE_KINDS.find(([pattern]) => pattern.test(text))?.[1] ?? 'other'
  return { type: 'event', author, createdAt: note.created_at, kind, text, label: null }
}

/**
 * Turns a discussion of GitLab into events of a timeline: a discussion about the code becomes a review
 * holding its thread, any other one its notes in order.
 * @param discussion The discussion.
 * @returns The events.
 */
function discussionEvents (discussion: GitlabDiscussion): ForgeTimelineEvent[] {
  const [first] = discussion.notes
  if (first?.type !== 'DiffNote') {
    return discussion.notes.map(noteEvent)
  }
  const thread: ForgeReviewThread = {
    path: first.position?.new_path ?? first.position?.old_path ?? '',
    line: first.position?.new_line ?? first.position?.old_line ?? null,
    diffHunk: null,
    resolved: first.resolved === true,
    outdated: false,
    comments: discussion.notes.map(note => ({ author: note.author?.username ?? null, body: note.body, createdAt: note.created_at }))
  }
  return [{ type: 'review', author: first.author?.username ?? null, createdAt: first.created_at, state: 'commented', body: '', threads: [thread] }]
}

/**
 * Gives the REST API of the project of a repository and the headers carrying a token.
 * @param repository The repository.
 * @param token The access token, null to read as an anonymous person.
 * @returns The address of the project in the API and the request options.
 */
function projectApi (repository: ForgeRepository, token: string | null): { api: string, project: string, init: RequestInit } {
  const api = `${new URL(repository.webUrl).origin}/api/v4`
  return { api, project: `${api}/projects/${encodeURIComponent(repository.path)}`, init: token ? { headers: { 'PRIVATE-TOKEN': token } } : {} }
}

/**
 * Reads open items of a project with the username the token belongs to.
 * @param repository The repository.
 * @param token The access token, null to read as an anonymous person.
 * @param list The list of the project, `merge_requests` or `issues`.
 * @param read Turns an item of GitLab into an item of the devtool.
 * @returns The username and the items.
 */
async function readItems<T, R extends GitlabItem> (repository: ForgeRepository, token: string | null, list: string, read: (item: R, viewer: string | null) => T): Promise<ForgeItems<T>> {
  const { api, project, init } = projectApi(repository, token)
  const [user, items] = await Promise.all([
    token ? requestJson<{ username: string }>('GitLab', `${api}/user`, init) : Promise.resolve(null),
    requestJson<R[]>('GitLab', `${project}/${list}?${LIST_QUERY}`, init)
  ])
  const viewer = user?.username ?? null
  return { viewer, items: items.map(item => read(item, viewer)) }
}

/**
 * Reads what every item of GitLab has.
 * @param item The merge request or the issue.
 * @param viewer The username of the token, null without token.
 * @returns Its number, title, link, author, description, labels, last change and whether the person wrote it.
 */
function baseOf (item: GitlabItem, viewer: string | null) {
  return {
    number: item.iid,
    title: item.title,
    url: item.web_url,
    author: item.author?.username ?? null,
    body: item.description ?? '',
    labels: (item.labels ?? []).map((label): ForgeLabel => ({ name: label.name, color: label.color })),
    updatedAt: item.updated_at,
    mine: viewer !== null && item.author?.username === viewer
  }
}

/** GitLab, hosted or on gitlab.com, read through its REST API. */
export const gitlab: GitForge = {
  name: 'gitlab',
  label: 'GitLab',
  icon: 'simple-icons:gitlab',

  matches (host) {
    return host === 'gitlab.com' || host.startsWith('gitlab.')
  },

  pullRequests (repository, token) {
    return readItems(repository, token, 'merge_requests', (mergeRequest: GitlabMergeRequest, viewer) => ({
      ...baseOf(mergeRequest, viewer),
      branch: mergeRequest.source_branch,
      base: mergeRequest.target_branch,
      draft: mergeRequest.draft,
      checks: mergeRequest.detailed_merge_status === 'ci_still_running' ? 'pending' : null,
      review: REVIEWS[mergeRequest.detailed_merge_status ?? ''] ?? null,
      reviewRequested: viewer !== null && (mergeRequest.reviewers ?? []).some(reviewer => reviewer.username === viewer)
    }))
  },

  issues (repository, token) {
    return readItems(repository, token, 'issues', (issue: GitlabIssue, viewer) => {
      const assignees = (issue.assignees ?? []).map(assignee => assignee.username)
      return { ...baseOf(issue, viewer), assignees, comments: issue.user_notes_count, assigned: viewer !== null && assignees.includes(viewer) }
    })
  },

  async timeline (repository, token, kind, number, page) {
    const { project, init } = projectApi(repository, token)
    const discussions: GitlabDiscussion[] = []
    for (let read = 1; read <= TIMELINE_PAGES; read += 1) {
      const answer = await requestJson<GitlabDiscussion[]>('GitLab', `${project}/${kind === 'pullRequests' ? 'merge_requests' : 'issues'}/${number}/discussions?per_page=100&page=${read}`, init)
      discussions.push(...answer)
      if (answer.length < 100) {
        break
      }
    }
    const events = discussions.flatMap(discussionEvents)
    const end = 'before' in page ? Math.min(Number(page.before) || 0, events.length) : events.length
    const start = 'last' in page ? Math.max(end - page.last, 0) : 0
    return { events: events.slice(start, end), before: start > 0 ? String(start) : null, remaining: start }
  }
}
