import type { ForgeKind, ForgeTimelinePage, ForgeTimelinePart, IssuePayload, PullRequestPayload } from '@appsys-sas/devtool-shared'
import type { ForgeRepository } from './repository.js'

const REQUEST_TIMEOUT = 15_000

/** Open items of a repository, as the owner of a token sees them. */
export interface ForgeItems<T> {
  /** The username the token belongs to, null without token. */
  viewer: string | null
  items: T[]
}

/** A service hosting git repositories, their pull requests and their issues. */
export interface GitForge {
  /** Its name in the configuration. */
  name: string
  /** The name shown to people. */
  label: string
  /** Iconify name of its icon. */
  icon: string
  /**
   * Tells whether a host is one of the forge when the configuration does not name it.
   * @param host The host, with its port.
   * @returns Whether the host belongs to the forge.
   */
  matches(host: string): boolean
  /**
   * Reads the open pull requests of a repository.
   * @param repository The repository.
   * @param token The access token, null to read as an anonymous person.
   * @returns The pull requests, the last changed first.
   * @throws {ForgeError} When the forge refuses or fails.
   */
  pullRequests(repository: ForgeRepository, token: string | null): Promise<ForgeItems<PullRequestPayload>>
  /**
   * Reads the open issues of a repository.
   * @param repository The repository.
   * @param token The access token, null to read as an anonymous person.
   * @returns The issues, the last changed first.
   * @throws {ForgeError} When the forge refuses or fails.
   */
  issues(repository: ForgeRepository, token: string | null): Promise<ForgeItems<IssuePayload>>
  /**
   * Reads a part of the timeline of a pull request or of an issue: comments, reviews, commits and changes.
   * @param repository The repository.
   * @param token The access token, null to read as an anonymous person.
   * @param kind Whether the item is a pull request or an issue.
   * @param number The number of the item.
   * @param page The last events, or every event before a place a previous part gave.
   * @returns What happened, the oldest first, and what comes before.
   * @throws {ForgeError} When the forge refuses or fails.
   */
  timeline(repository: ForgeRepository, token: string | null, kind: ForgeKind, number: number, page: ForgeTimelinePage): Promise<ForgeTimelinePart>
}

/** A refusal or a failure of a forge. */
export class ForgeError extends Error {
  /**
   * @param status The HTTP status of the answer, 0 when the forge was not reached.
   * @param message Why the request failed.
   */
  constructor (
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'ForgeError'
  }
}

/**
 * Calls a JSON API of a forge.
 * @param label The name of the forge, in the messages.
 * @param url The address called.
 * @param init The other request options.
 * @returns The decoded answer.
 * @throws {ForgeError} When the forge cannot be reached or answers an error.
 */
export async function requestJson<T> (label: string, url: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT) })
  } catch (error) {
    throw new ForgeError(0, `${label} unreachable: ${error instanceof Error ? error.message : String(error)}`)
  }

  const body = (await response.json().catch(() => null)) as { message?: unknown, error?: unknown } | null
  if (!response.ok) {
    const message = typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : response.statusText
    throw new ForgeError(response.status, `${label} ${response.status}: ${message}`)
  }
  return body as T
}
