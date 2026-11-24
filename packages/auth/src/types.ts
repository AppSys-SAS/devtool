/** Identity of a signed-in developer, as the identity provider describes it. */
export interface AuthUser {
  name: string | null
  username: string | null
  /** Missing in sessions opened before it was kept. */
  email?: string | null
  groups: string[]
}

/** Tokens of a signed-in developer, kept between runs. */
export interface AuthSession {
  accessToken: string
  /** Expiry of the access token, in milliseconds since the epoch. */
  expiresAt: number
  refreshToken: string | null
  /** Identity read at sign-in and at each renewal; missing for sessions opened before it was kept. */
  user?: AuthUser | null
}

/** Settings every identity provider shares. */
export interface AuthProviderOptions {
  /** The identity provider. */
  type: string
  /** Name shown in the sign-in texts, null when the configuration gives none. */
  name: string | null
}

/** A problem of the `auth` section of the configuration. */
export interface AuthProblem {
  /** Path of the setting, such as `auth.issuer`. */
  setting: string
  message: string
}

/** Opens the sign-in address for the developer. */
export type UrlOpener = (url: string) => void | Promise<void>

/** Signs developers in with one kind of identity provider. */
export interface AuthProvider<T extends AuthProviderOptions> {
  readonly type: T['type']
  /**
   * Reads the settings of the provider from the `auth` section.
   * @param section The raw `auth` section.
   * @returns The options, null when the section is incomplete, and the problems of the section.
   */
  readOptions: (section: Record<string, unknown>) => { options: T | null, problems: AuthProblem[] }
  /**
   * Tells whether a saved session was opened with these options.
   * @param options The options.
   * @param session The raw saved session.
   * @returns True when the session belongs to them.
   */
  owns: (options: T, session: Record<string, unknown>) => boolean
  /**
   * Signs the developer in.
   * @param options The options.
   * @param openUrl Opens the sign-in address.
   * @returns The new session.
   */
  signIn: (options: T, openUrl: UrlOpener) => Promise<AuthSession>
  /**
   * Renews an expired session.
   * @param options The options.
   * @param session The expired session.
   * @returns The renewed session.
   */
  renew: (options: T, session: AuthSession) => Promise<AuthSession>
}

/** Raised when no valid session lets the devtool act for the developer. */
export class AuthSignInRequiredError extends Error {
  /**
   * @param reason Why a sign-in is required.
   */
  constructor (reason: string) {
    super(`${reason}: run \`devtool login\``)
    this.name = 'AuthSignInRequiredError'
  }
}
