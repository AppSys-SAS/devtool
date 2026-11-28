import type { EnvironmentCopyPayload, EnvironmentItemPayload } from '@appsys-sas/devtool-shared'

/** How far apart two dates of the same copy can be, the stores keeping dates at various precisions. */
export const SAME_DATE_TOLERANCE_MS = 1000

/**
 * Tells whether two dates differ by more than the precision of the stores.
 * @param date The first date, in ISO format.
 * @param other The second date, in ISO format.
 * @returns True when they differ.
 */
export function differs (date: string, other: string): boolean {
  return Math.abs(new Date(date).getTime() - new Date(other).getTime()) > SAME_DATE_TOLERANCE_MS
}

/**
 * Tells whether the copy of a backend changed since the last sync: by its version when the backend
 * gives one, else by its date.
 * @param remote The copy of the backend.
 * @param synced The last sync.
 * @returns True when it changed.
 */
export function remoteChangedSince (remote: EnvironmentCopyPayload, synced: NonNullable<EnvironmentItemPayload['synced']>): boolean {
  return remote.version !== null && synced.remoteVersion !== null ? remote.version !== synced.remoteVersion : differs(remote.updatedAt, synced.remoteUpdatedAt)
}
