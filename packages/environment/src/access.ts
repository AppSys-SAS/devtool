import { type AuthOptions, sessionStatus } from '@appsys-sas/devtool-auth'

/** A transfer direction: the copies of the backend replace the local ones, or the reverse. */
export type TransferDirection = 'pull' | 'push'

/** Who may transfer in one direction: everyone (null), nobody (false), or the members of one of the groups. */
export type TransferGroups = string[] | false | null

/** Who may pull and who may push. */
export interface TransferAccess {
  pull: TransferGroups
  push: TransferGroups
}

/** Access letting everyone pull and push. */
export const OPEN_ACCESS: TransferAccess = { pull: null, push: null }

const DIRECTIONS: TransferDirection[] = ['pull', 'push']

/**
 * Reads `groups: { pull, push }`, each a non-empty list of groups of the identity provider or false.
 *
 * @param value - The raw `groups` setting.
 * @returns The groups by direction, null for a direction left out, and the problems of the setting.
 */
export function readTransferGroups (value: unknown): { groups: TransferAccess, problems: string[] } {
  const groups: TransferAccess = { ...OPEN_ACCESS }
  if (value === undefined) {
    return { groups, problems: [] }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { groups, problems: ['must be a map of pull and push groups'] }
  }

  const problems: string[] = []
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record).filter(key => !DIRECTIONS.includes(key as TransferDirection))) {
    problems.push(`${key} is unknown: only pull and push`)
  }
  for (const direction of DIRECTIONS) {
    const entry = record[direction]
    if (entry === undefined) {
      continue
    }
    if (entry === false || (Array.isArray(entry) && entry.length > 0 && entry.every(group => typeof group === 'string' && group !== ''))) {
      groups[direction] = entry as string[] | false
    } else {
      problems.push(`${direction} must be a non-empty list of groups, or false`)
    }
  }
  return { groups, problems }
}

/**
 * Gives the groups of each direction, those of an item replacing those of its backend, except where
 * the backend refuses everyone.
 *
 * @param item - The groups of the item.
 * @param backend - The groups of its backend.
 * @returns The groups by direction.
 */
export function mergeTransferGroups (item: TransferAccess, backend: TransferAccess): TransferAccess {
  return {
    pull: backend.pull === false ? false : item.pull ?? backend.pull,
    push: backend.push === false ? false : item.push ?? backend.push
  }
}

/**
 * Tells the signed-in developer the groups of a direction let transfer, reading the saved session once.
 */
export class TransferGate {
  private _groups: Promise<string[] | null> | null = null

  /**
   * @param _auth - The identity provider signing the developers in, null when the configuration declares none.
   */
  constructor (private readonly _auth: AuthOptions | null) {}

  /**
   * Explains why the developer may not transfer.
   *
   * @param groups - The groups allowed to transfer in that direction.
   * @param direction - The direction.
   * @returns Why the transfer is refused, null when it is allowed.
   */
  async refusal (groups: TransferGroups, direction: TransferDirection): Promise<string | null> {
    if (groups === null) {
      return null
    }
    if (groups === false) {
      return `${direction} is disabled`
    }

    const needed = `${direction} needs one of the groups ${groups.join(', ')}`
    if (this._auth === null) {
      return `${needed}, and the configuration declares no auth section`
    }
    const userGroups = await this.userGroups()
    if (userGroups === null) {
      return `${needed}: sign in with \`devtool login\``
    }
    return groups.some(group => userGroups.includes(group)) ? null : needed
  }

  /**
   * Reads the groups of the signed-in developer.
   *
   * @returns The groups, null when no developer is signed in.
   */
  private async userGroups (): Promise<string[] | null> {
    const auth = this._auth
    this._groups ??= auth === null
      ? Promise.resolve(null)
      : sessionStatus(auth).then(status => (status.signedIn ? status.user?.groups ?? [] : null))
    return this._groups
  }
}
