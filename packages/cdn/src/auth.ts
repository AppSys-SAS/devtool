import { spawn } from "node:child_process";
import { createServer } from "node:http";
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
  validateAuthResponse,
} from "oauth4webapi";
import type { CdnOptions } from "./options.js";
import { type CdnSession, type CdnUser, deleteSession, readSession, withSessionLock, writeSession } from "./session.js";

const SCOPES = "openid offline_access groups profile";
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const EXPIRY_MARGIN_MS = 60_000;
const CALLBACK_PAGE = "<!doctype html><meta charset=\"utf-8\"><title>Devtool</title><p>Devtool : connexion terminée, vous pouvez fermer cet onglet.</p>";

/** Raised when no valid session lets the devtool call the CDN. */
export class CdnSignInRequiredError extends Error {
  /**
   * @param reason - Why a sign-in is required.
   */
  constructor(reason: string) {
    super(`${reason}: run \`devtool login\``);
    this.name = "CdnSignInRequiredError";
  }
}

/**
 * Loads the metadata of the issuer.
 *
 * @param options - The CDN options naming the issuer.
 * @returns The authorization server.
 */
async function discover(options: CdnOptions): Promise<AuthorizationServer> {
  const issuer = new URL(options.issuer);

  return processDiscoveryResponse(issuer, await discoveryRequest(issuer));
}

/**
 * Builds the session kept from a token response.
 *
 * @param options - The CDN options naming the issuer and client.
 * @param tokens - The token response.
 * @param previousRefreshToken - The refresh token to keep when the response carries none.
 * @returns The session.
 */
function sessionOf(options: CdnOptions, tokens: TokenEndpointResponse, previousRefreshToken: string | null, user: CdnUser | null): CdnSession {
  return {
    issuer: options.issuer,
    clientId: options.clientId,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 0) * 1000,
    refreshToken: tokens.refresh_token ?? previousRefreshToken,
    user,
  };
}

/**
 * Reads the identity of the developer from the user information endpoint of the issuer.
 *
 * @param server - The authorization server.
 * @param client - The client.
 * @param tokens - The tokens of the sign-in.
 * @returns The identity, or null when the issuer publishes no such endpoint.
 */
async function readUser(server: AuthorizationServer, client: Client, tokens: TokenEndpointResponse): Promise<CdnUser | null> {
  if (server.userinfo_endpoint === undefined) {
    return null;
  }

  const subject = getValidatedIdTokenClaims(tokens)?.sub ?? skipSubjectCheck;
  const info = await processUserInfoResponse(server, client, subject, await userInfoRequest(server, client, tokens.access_token));
  return {
    name: typeof info.name === "string" ? info.name : null,
    username: typeof info.preferred_username === "string" ? info.preferred_username : null,
    groups: Array.isArray(info.groups) ? info.groups.filter((group): group is string => typeof group === "string") : [],
  };
}

/**
 * Opens an address in the default browser of the system.
 *
 * @param url - The address.
 */
export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(command, args, { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
}

/**
 * Waits for the issuer to redirect the browser to the local callback address.
 *
 * @param port - The local port.
 * @param ready - Called once the port listens.
 * @returns The callback address with its parameters.
 */
async function waitForCallback(port: number, ready: () => void | Promise<void>): Promise<URL> {
  return new Promise<URL>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("sign-in timed out"));
    }, LOGIN_TIMEOUT_MS);
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }

      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(CALLBACK_PAGE);
      clearTimeout(timeout);
      server.close();
      resolve(url);
    });
    server.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      Promise.resolve(ready()).catch(reject);
    });
  });
}

/**
 * Signs the developer in with the authorization code flow and PKCE: the browser opens on the
 * issuer, which redirects to a local address. The tokens are saved for the next runs.
 *
 * @param options - The CDN options.
 * @param openUrl - Opens the sign-in address for the developer.
 */
export async function login(options: CdnOptions, openUrl: (url: string) => void | Promise<void> = openInBrowser): Promise<void> {
  const server = await discover(options);
  if (server.authorization_endpoint === undefined) {
    throw new Error(`${options.issuer} publishes no authorization endpoint`);
  }

  const client: Client = { client_id: options.clientId };
  const redirectUri = `http://127.0.0.1:${options.callbackPort}/callback`;
  const codeVerifier = generateRandomCodeVerifier();
  const state = generateRandomState();
  const authorizationUrl = new URL(server.authorization_endpoint);
  authorizationUrl.search = new URLSearchParams({
    client_id: options.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: await calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: "S256",
  }).toString();

  const callbackUrl = await waitForCallback(options.callbackPort, () => openUrl(authorizationUrl.toString()));
  const parameters = validateAuthResponse(server, client, callbackUrl, state);
  const response = await authorizationCodeGrantRequest(server, client, None(), parameters, redirectUri, codeVerifier);
  const tokens = await processAuthorizationCodeResponse(server, client, response);
  await writeSession(sessionOf(options, tokens, null, await readUser(server, client, tokens)));
}

/**
 * Signs the developer out of the devtool, forgetting its tokens.
 */
export async function logout(): Promise<void> {
  await deleteSession();
}

/**
 * Tells whether a session is saved for the issuer and client.
 *
 * @param options - The CDN options.
 * @returns True when the developer signed in.
 */
export async function hasSession(options: CdnOptions): Promise<boolean> {
  return (await readSession(options)) !== null;
}

/** What the saved session tells about the developer. */
export interface CdnSessionStatus {
  signedIn: boolean;
  user: CdnUser | null;
}

/**
 * Describes the saved session: signed in while it holds a valid access token or a refresh token.
 *
 * @param options - The CDN options.
 * @returns The status.
 */
export async function sessionStatus(options: CdnOptions): Promise<CdnSessionStatus> {
  const session = await readSession(options);
  const signedIn = session !== null && (session.refreshToken !== null || session.expiresAt > Date.now());

  return { signedIn, user: signedIn ? (session?.user ?? null) : null };
}

/**
 * Gives a valid access token, renewed with the refresh token when it expires.
 *
 * @param options - The CDN options.
 * @returns The access token.
 */
export async function accessToken(options: CdnOptions): Promise<string> {
  const current = await readSession(options);
  if (current !== null && current.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return current.accessToken;
  }

  return withSessionLock(async () => {
    const session = await readSession(options);
    if (session === null) {
      throw new CdnSignInRequiredError("not signed in");
    }

    if (session.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
      return session.accessToken;
    }

    if (session.refreshToken === null) {
      throw new CdnSignInRequiredError("session expired");
    }

    const server = await discover(options);
    const client: Client = { client_id: options.clientId };
    let tokens: TokenEndpointResponse;
    try {
      tokens = await processRefreshTokenResponse(server, client, await refreshTokenGrantRequest(server, client, None(), session.refreshToken));
    } catch (error) {
      if (error instanceof ResponseBodyError) {
        throw new CdnSignInRequiredError(`session renewal refused (${error.error})`);
      }

      throw error;
    }

    const renewed = sessionOf(options, tokens, session.refreshToken, session.user ?? null);
    await writeSession(renewed);

    return renewed.accessToken;
  });
}
