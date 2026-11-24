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
  if (typeof record.url !== 'string' || typeof auth.issuer !== 'string' || typeof auth.clientId !== 'string') {
    return null
  }

  const callbackPort = Number(auth.callbackPort ?? DEFAULT_CALLBACK_PORT)

  return {
    url: record.url.replace(/\/+$/, ''),
    issuer: auth.issuer.replace(/\/+$/, ''),
    issuerName: typeof auth.name === 'string' && auth.name.trim() ? auth.name.trim() : null,
    clientId: auth.clientId,
    callbackPort: Number.isInteger(callbackPort) && callbackPort > 0 ? callbackPort : DEFAULT_CALLBACK_PORT
  }
}
