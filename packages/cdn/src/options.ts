import { type AuthOptions, readAuthOptions } from '@appsys/devtool-auth'

/** Where the CDN lives and how the developers sign in to it. */
export interface CdnOptions {
  /** Base address of the CDN, without trailing slash. */
  url: string
  /** Identity provider whose access token the CDN accepts. */
  auth: AuthOptions
}

/**
 * Reads the `cdn` section of the devtool configuration, `{ url }`, with the `auth` section signing the
 * developers in.
 * @param section The raw `cdn` section.
 * @param authSection The raw `auth` section.
 * @returns The options, or null when either section is missing or incomplete.
 */
export function readCdnOptions (section: unknown, authSection: unknown): CdnOptions | null {
  if (typeof section !== 'object' || section === null) {
    return null
  }

  const url = (section as Record<string, unknown>).url
  const { options: auth } = readAuthOptions(authSection)
  if (typeof url !== 'string' || url.trim() === '' || auth === null) {
    return null
  }
  return { url: url.replace(/\/+$/, ''), auth }
}
