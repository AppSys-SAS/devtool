/** Where the CDN lives and how to sign in to it. */
export interface CdnOptions {
  /** Base address of the CDN, without trailing slash. */
  url: string
  /** OpenID Connect issuer signing in the developers. */
  issuer: string
  /** Name shown for the issuer, null when the configuration gives none. */
  issuerName: string | null
  /** Public client of the devtool at the issuer. */
  clientId: string
  /** Local port receiving the sign-in redirection. */
  callbackPort: number
}

const DEFAULT_CALLBACK_PORT = 6732
const MAX_PORT = 65535

/**
 * Reads a setting that must hold a non-blank text.
 *
 * @param value - The raw setting.
 * @returns The text, null when the setting is not a string or is blank.
 */
function readText (value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Reads a port given as an integer or as a string of decimal digits.
 *
 * @param value - The raw setting.
 * @returns The port, null when the setting is not a port between 1 and 65535.
 */
function readPort (value: unknown): number | null {
  const port = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : Number.NaN
  return Number.isInteger(port) && port >= 1 && port <= MAX_PORT ? port : null
}

/**
 * Reads the `cdn` section of the devtool configuration, `{ url, openid: { issuer, name, clientId, callbackPort } }`.
 *
 * @param section - The raw `cdn` section.
 * @returns The options, or null when the section is missing or incomplete.
 */
export function readCdnOptions (section: unknown): CdnOptions | null {
  if (typeof section !== 'object' || section === null) {
    return null
  }

  const record = section as Record<string, unknown>
  const auth = typeof record.openid === 'object' && record.openid !== null ? (record.openid as Record<string, unknown>) : {}
  const url = readText(record.url)
  const issuer = readText(auth.issuer)
  const clientId = readText(auth.clientId)
  if (url === null || issuer === null || clientId === null) {
    return null
  }

  return {
    url: url.replace(/\/+$/, ''),
    issuer: issuer.replace(/\/+$/, ''),
    issuerName: readText(auth.name)?.trim() ?? null,
    clientId,
    callbackPort: readPort(auth.callbackPort) ?? DEFAULT_CALLBACK_PORT
  }
}
