const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Says when a certificate expires, or expired.
 * @param expiresAt The end of its validity, in ISO format.
 * @returns The label.
 */
export function expiryLabel (expiresAt: string): string {
  const date = new Date(expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' })
  return new Date(expiresAt).getTime() < Date.now() ? `expired ${date}` : `expires ${date}`
}

/**
 * Tells whether a certificate expires within some days.
 * @param expiresAt The end of its validity, in ISO format.
 * @param days The days.
 * @returns True when it expires within them, or expired.
 */
export function expiresWithin (expiresAt: string, days: number): boolean {
  return new Date(expiresAt).getTime() - Date.now() < days * DAY_MS
}

/**
 * Colors the expiry of a certificate: red once expired, amber within the days of its warning.
 * @param expiresAt The end of its validity, in ISO format.
 * @param warnDays Days before the expiry from which it warns.
 * @returns The classes.
 */
export function expiryClass (expiresAt: string, warnDays = 30): string {
  if (expiresWithin(expiresAt, 0)) {
    return 'text-destructive'
  }
  return expiresWithin(expiresAt, warnDays) ? 'text-amber-600 dark:text-amber-400' : ''
}
