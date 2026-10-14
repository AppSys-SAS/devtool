import { type FSWatcher, mkdirSync, watch } from "node:fs";
import path from "node:path";
import { type CdnOptions, login, logout, readCdnOptions, sessionPath, sessionStatus } from "@appsys/devtool-cdn";
import { type CdnSessionPayload, logger } from "@appsys/devtool-shared";

const CHANGE_DELAY_MS = 200;

/**
 * Sign-in state of the developer on the CDN: published to the interface whenever the saved session
 * changes, whoever changed it, and changed on request of the interface.
 */
export class DevtoolCdnSession {
  private _options: CdnOptions | null = null;
  private _pendingLoginUrl: string | null = null;
  private _error: string | null = null;
  private _signingIn = false;
  private _watcher: FSWatcher | null = null;
  private _changeTimer: NodeJS.Timeout | null = null;

  /**
   * @param _publish - Sends the state to every connected interface.
   */
  constructor(private readonly _publish: (payload: CdnSessionPayload) => Promise<void>) {}

  /**
   * Takes the CDN section of the configuration and starts watching the saved session.
   *
   * @param section - The raw `cdn` section.
   */
  configure(section: unknown): void {
    this._options = readCdnOptions(section);
    this.watchSession();
  }

  /**
   * Describes the current state.
   *
   * @returns The state.
   */
  async status(): Promise<CdnSessionPayload> {
    if (!this._options) {
      return { configured: false, signedIn: false, user: null, pendingLoginUrl: null, error: null };
    }

    const { signedIn, user } = await sessionStatus(this._options);
    return { configured: true, signedIn, user, pendingLoginUrl: this._pendingLoginUrl, error: this._error };
  }

  /**
   * Signs the developer in: publishes the sign-in address for the interface to open, then waits for
   * the issuer, and publishes why it failed if it does. A second request while one is waiting does
   * nothing.
   */
  async login(): Promise<void> {
    if (!this._options || this._signingIn) {
      return;
    }

    this._signingIn = true;
    this._error = null;
    try {
      await login(this._options, async (url) => {
        this._pendingLoginUrl = url;
        await this.publish();
      });
    } catch (error) {
      this._error = error instanceof Error ? error.message : String(error);
      logger.warn("Server", "CDN", `Sign-in failed: ${this._error}`);
    } finally {
      this._signingIn = false;
      this._pendingLoginUrl = null;
      await this.publish();
    }
  }

  /**
   * Signs the developer out.
   */
  async logout(): Promise<void> {
    this._error = null;
    await logout();
    await this.publish();
  }

  /**
   * Publishes the current state.
   */
  async publish(): Promise<void> {
    await this._publish(await this.status());
  }

  /**
   * Watches the directory of the saved session, written by renaming a new file over it, and
   * publishes the state shortly after it changes.
   */
  private watchSession(): void {
    if (this._watcher || !this._options) {
      return;
    }

    const directory = path.dirname(sessionPath());
    const fileName = path.basename(sessionPath());
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this._watcher = watch(directory, (_event, changed) => {
      if (changed !== fileName) {
        return;
      }

      if (this._changeTimer) {
        clearTimeout(this._changeTimer);
      }
      this._changeTimer = setTimeout(() => {
        this.publish().catch((error: unknown) => {
          logger.warn("Server", "CDN", `Session state not published: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, CHANGE_DELAY_MS);
    });
  }
}
