import { openInBrowser } from './browser.js'
import { openid, type OpenIdOptions } from './openid.js'
import { deleteSession, readSession, withSessionLock, writeSession } from './session.js'
import { type AuthProblem, type AuthProvider, AuthSignInRequiredError, type AuthUser, type UrlOpener } from './types.js'

export { openInBrowser } from './browser.js'
export type { OpenIdOptions } from './openid.js'
export { sessionPath } from './session.js'
export { type AuthProblem, AuthSignInRequiredError, type AuthUser } from './types.js'

/** Settings of the identity provider signing the developers in. */
export type AuthOptions = OpenIdOptions

/** What the saved session tells about the developer. */
export interface AuthSessionStatus {
  signedIn: boolean
  user: AuthUser | null
}

/** Values of the signed-in developer a configuration reads with `{{ auth://<value> }}`. */
export const AUTH_VALUES = ['token', 'username', 'name', 'email', 'groups'] as const
export type AuthValue = typeof AUTH_VALUES[number]

const EXPIRY_MARGIN_MS = 60_000

const AUTH_PROVIDERS: { [T in AuthOptions['type']]: AuthProvider<Extract<AuthOptions, { type: T }>> } = { openid }

/** Types of identity provider the `auth` section accepts. */
export const AUTH_TYPES = Object.keys(AUTH_PROVIDERS)

/**
 * Gives the provider of some settings.
 * @param options The settings.
 * @returns Their provider.
 */
function providerOf (options: AuthOptions): AuthProvider<AuthOptions> {
  return AUTH_PROVIDERS[options.type]
}

/**
 * Reads the `auth` section of the devtool configuration, its `type` (default `openid`) naming the
 * identity provider whose settings follow.
 * @param section The raw `auth` section.
 * @returns The options, null when the section is missing or incomplete, and its problems.
 */
export function readAuthOptions (section: unknown): { options: AuthOptions | null, problems: AuthProblem[] } {
  if (section === undefined || section === null) {
    return { options: null, problems: [] }
  }
  if (typeof section !== 'object' || Array.isArray(section)) {
    return { options: null, problems: [{ setting: 'auth', message: 'must be a map' }] }
  }

  const record = section as Record<string, unknown>
  const type = record.type ?? 'openid'
  if (typeof type !== 'string' || !Object.hasOwn(AUTH_PROVIDERS, type)) {
    return { options: null, problems: [{ setting: 'auth.type', message: `must be one of ${AUTH_TYPES.join(', ')}` }] }
  }
  return AUTH_PROVIDERS[type as AuthOptions['type']].readOptions(record)
}

/**
 * Signs the developer in and saves the session for the next runs.
 * @param options The settings of the identity provider.
 * @param openUrl Opens the sign-in address for the developer.
 */
export async function login (options: AuthOptions, openUrl: UrlOpener = openInBrowser): Promise<void> {
  await writeSession(await providerOf(options).signIn(options, openUrl))
}

/**
 * Signs the developer out of the devtool, forgetting its tokens.
 */
export async function logout (): Promise<void> {
  await deleteSession()
}

/**
 * Describes the saved session: signed in while it holds a valid access token or a refresh token.
 * @param options The settings of the identity provider.
 * @returns The status.
 */
export async function sessionStatus (options: AuthOptions): Promise<AuthSessionStatus> {
  const session = await readSession(raw => providerOf(options).owns(options, raw))
  const signedIn = session !== null && (session.refreshToken !== null || session.expiresAt > Date.now())
  return { signedIn, user: signedIn ? (session?.user ?? null) : null }
}

/**
 * Gives a valid access token, the session renewed when it expires.
 * @param options The settings of the identity provider.
 * @returns The access token.
 */
export async function accessToken (options: AuthOptions): Promise<string> {
  const provider = providerOf(options)
  const owns = (raw: Record<string, unknown>): boolean => provider.owns(options, raw)
  const current = await readSession(owns)
  if (current !== null && current.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return current.accessToken
  }

  return withSessionLock(async () => {
    const session = await readSession(owns)
    if (session === null) {
      throw new AuthSignInRequiredError('not signed in')
    }
    if (session.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
      return session.accessToken
    }

    const renewed = await provider.renew(options, session)
    await writeSession(renewed)
    return renewed.accessToken
  })
}

/**
 * Gives the reader of the values of the signed-in developer for some settings.
 * @param options The settings of the identity provider, null when the configuration declares none.
 * @returns Reads a value, failing when no identity provider is configured.
 */
export function authReaderOf (options: AuthOptions | null): (value: AuthValue) => Promise<string> {
  return async value => {
    if (options === null) {
      throw new Error(`auth://${value}: no \`auth\` section in the devtool configuration`)
    }
    return authValue(options, value)
  }
}

/**
 * Gives a value of the signed-in developer, the session renewed first when it expired.
 * @param options The settings of the identity provider.
 * @param value The value: the access token, the user name, display name or email, or the groups separated by commas.
 * @returns The value.
 */
export async function authValue (options: AuthOptions, value: AuthValue): Promise<string> {
  const token = await accessToken(options)
  if (value === 'token') {
    return token
  }

  const user = (await sessionStatus(options)).user
  const text = value === 'groups' ? user?.groups.join(',') : user?.[value]
  if (text === undefined || text === null) {
    throw new Error(`auth://${value}: ${options.name ?? 'the identity provider'} gives no ${value}`)
  }
  return text
}
