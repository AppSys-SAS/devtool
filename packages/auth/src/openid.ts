import {
  authorizationCodeGrantRequest,
  type AuthorizationServer,
  calculatePKCECodeChallenge,
  type Client,
  discoveryRequest,
  generateRandomCodeVerifier,
  generateRandomState,
  getValidatedIdTokenClaims,
  None,
  processAuthorizationCodeResponse,
  processDiscoveryResponse,
  processRefreshTokenResponse,
  processUserInfoResponse,
  refreshTokenGrantRequest,
  ResponseBodyError,
  skipSubjectCheck,
  type TokenEndpointResponse,
  userInfoRequest,
  validateAuthResponse
} from 'oauth4webapi'
import { waitForCallback } from './browser.js'
import { type AuthProblem, type AuthProvider, type AuthProviderOptions, type AuthSession, AuthSignInRequiredError, type AuthUser } from './types.js'

const DEFAULT_SCOPES = ['openid', 'offline_access', 'groups', 'profile']
const DEFAULT_CALLBACK_PORT = 6732
const MAX_PORT = 65535

/** Settings of an OpenID Connect issuer. */
export interface OpenIdOptions extends AuthProviderOptions {
  type: 'openid'
  /** The issuer, without trailing slash. */
  issuer: string
  /** Public client of the devtool at the issuer. */
  clientId: string
  /** Local port receiving the sign-in redirection. */
  callbackPort: number
  /** Scopes asked at sign-in. */
  scopes: string[]
}

/** A session opened with an OpenID Connect issuer. */
interface OpenIdSession extends AuthSession {
  issuer: string
  clientId: string
}

/**
 * Reads a setting that must hold a non-blank text.
 * @param value The raw setting.
 * @returns The text, null when the setting is not a string or is blank.
 */
function readText (value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Reads a port given as an integer or as a string of decimal digits.
 * @param value The raw setting.
 * @returns The port, null when the setting is not a port between 1 and 65535.
 */
function readPort (value: unknown): number | null {
  const port = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : Number.NaN
  return Number.isInteger(port) && port >= 1 && port <= MAX_PORT ? port : null
}

/**
 * Reads the scopes to ask, a list of non-blank texts holding `openid`.
 * @param value The raw setting.
 * @returns The scopes, null when the setting is not such a list.
 */
function readScopes (value: unknown): string[] | null {
  const scopes = Array.isArray(value) ? value.map(readText) : null
  return scopes?.every(scope => scope !== null) && scopes.includes('openid') ? scopes : null
}

/**
 * Loads the metadata of the issuer.
 * @param options The options naming the issuer.
 * @returns The authorization server.
 */
async function discover (options: OpenIdOptions): Promise<AuthorizationServer> {
  const issuer = new URL(options.issuer)
  return processDiscoveryResponse(issuer, await discoveryRequest(issuer))
}

/**
 * Reads the identity of the developer from the user information endpoint of the issuer.
 * @param server The authorization server.
 * @param client The client.
 * @param tokens The tokens of the sign-in or of the renewal.
 * @returns The identity, or null when the issuer publishes no such endpoint.
 */
async function readUser (server: AuthorizationServer, client: Client, tokens: TokenEndpointResponse): Promise<AuthUser | null> {
  if (server.userinfo_endpoint === undefined) {
    return null
  }

  const subject = getValidatedIdTokenClaims(tokens)?.sub ?? skipSubjectCheck
  const info = await processUserInfoResponse(server, client, subject, await userInfoRequest(server, client, tokens.access_token))
  return {
    name: typeof info.name === 'string' ? info.name : null,
    username: typeof info.preferred_username === 'string' ? info.preferred_username : null,
    email: typeof info.email === 'string' ? info.email : null,
    groups: Array.isArray(info.groups) ? info.groups.filter((group): group is string => typeof group === 'string') : []
  }
}

/**
 * Builds the session kept from a token response.
 * @param options The options naming the issuer and client.
 * @param tokens The token response.
 * @param previousRefreshToken The refresh token to keep when the response carries none.
 * @param user The identity of the developer.
 * @returns The session.
 */
function sessionOf (options: OpenIdOptions, tokens: TokenEndpointResponse, previousRefreshToken: string | null, user: AuthUser | null): OpenIdSession {
  return {
    issuer: options.issuer,
    clientId: options.clientId,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 0) * 1000,
    refreshToken: tokens.refresh_token ?? previousRefreshToken,
    user
  }
}

/** Signs developers in with the authorization code flow and PKCE of an OpenID Connect issuer. */
export const openid: AuthProvider<OpenIdOptions> = {
  type: 'openid',

  readOptions (section) {
    const problems: AuthProblem[] = []
    const issuer = readText(section.issuer)
    const clientId = readText(section.clientId)
    const callbackPort = section.callbackPort === undefined ? DEFAULT_CALLBACK_PORT : readPort(section.callbackPort)
    const scopes = section.scopes === undefined ? DEFAULT_SCOPES : readScopes(section.scopes)
    if (issuer === null) {
      problems.push({ setting: 'auth.issuer', message: 'must be the address of the OpenID Connect issuer' })
    }
    if (clientId === null) {
      problems.push({ setting: 'auth.clientId', message: 'must be the client of the devtool at the issuer' })
    }
    if (callbackPort === null) {
      problems.push({ setting: 'auth.callbackPort', message: `must be a port between 1 and ${MAX_PORT}, ${DEFAULT_CALLBACK_PORT} is used` })
    }
    if (scopes === null) {
      problems.push({ setting: 'auth.scopes', message: `must be a list of scopes holding openid, ${DEFAULT_SCOPES.join(' ')} is used` })
    }
    if (issuer === null || clientId === null) {
      return { options: null, problems }
    }

    return {
      options: {
        type: 'openid',
        name: readText(section.name)?.trim() ?? null,
        issuer: issuer.replace(/\/+$/, ''),
        clientId,
        callbackPort: callbackPort ?? DEFAULT_CALLBACK_PORT,
        scopes: scopes ?? DEFAULT_SCOPES
      },
      problems
    }
  },

  owns (options, session) {
    return session.issuer === options.issuer && session.clientId === options.clientId
  },

  async signIn (options, openUrl) {
    const server = await discover(options)
    if (server.authorization_endpoint === undefined) {
      throw new Error(`${options.issuer} publishes no authorization endpoint`)
    }

    const client: Client = { client_id: options.clientId }
    const redirectUri = `http://127.0.0.1:${options.callbackPort}/callback`
    const codeVerifier = generateRandomCodeVerifier()
    const state = generateRandomState()
    const authorizationUrl = new URL(server.authorization_endpoint)
    authorizationUrl.search = new URLSearchParams({
      client_id: options.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: options.scopes.join(' '),
      state,
      code_challenge: await calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256'
    }).toString()

    const callbackUrl = await waitForCallback(options.callbackPort, () => openUrl(authorizationUrl.toString()))
    const parameters = validateAuthResponse(server, client, callbackUrl, state)
    const response = await authorizationCodeGrantRequest(server, client, None(), parameters, redirectUri, codeVerifier)
    const tokens = await processAuthorizationCodeResponse(server, client, response)
    return sessionOf(options, tokens, null, await readUser(server, client, tokens))
  },

  async renew (options, session) {
    if (session.refreshToken === null) {
      throw new AuthSignInRequiredError('session expired')
    }

    const server = await discover(options)
    const client: Client = { client_id: options.clientId }
    let tokens: TokenEndpointResponse
    try {
      tokens = await processRefreshTokenResponse(server, client, await refreshTokenGrantRequest(server, client, None(), session.refreshToken))
    } catch (error) {
      if (error instanceof ResponseBodyError) {
        throw new AuthSignInRequiredError(`session renewal refused (${error.error})`)
      }
      throw error
    }

    const user = await readUser(server, client, tokens).catch(() => session.user ?? null)
    return sessionOf(options, tokens, session.refreshToken, user)
  }
}
