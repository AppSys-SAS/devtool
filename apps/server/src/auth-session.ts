import { type FSWatcher, mkdirSync, watch } from 'node:fs'
import path from 'node:path'
import { type AuthOptions, authReaderOf, type AuthValue, login, logout, readAuthOptions, sessionPath, sessionStatus } from '@appsys-sas/devtool-auth'
import { type AuthSessionPayload, logger } from '@appsys-sas/devtool-shared'

const CHANGE_DELAY_MS = 200

/**
 * Sign-in state of the developer with the identity provider of the configuration: published to the
 * interface whenever the saved session changes, whoever changed it, and changed on request of the
 * interface.
 */
export class DevtoolAuthSession {
  private _options: AuthOptions | null = null
  private _pendingLoginUrl: string | null = null
  private _error: string | null = null
  private _signingIn = false
  private _watcher: FSWatcher | null = null
  private _changeTimer: NodeJS.Timeout | null = null

  /**
   * @param _publish Sends the state to every connected interface.
   */
  constructor (private readonly _publish: (payload: AuthSessionPayload) => Promise<void>) {}

  /**
   * Takes the `auth` section of the configuration and starts watching the saved session.
   * @param section The raw `auth` section.
   */
  configure (section: unknown): void {
    this._options = readAuthOptions(section).options
    this.watchSession()
  }

  /**
   * Gives a value of the signed-in developer, for the `{{ auth://<value> }}` value blocks.
   * @param value The value.
   * @returns The value, read from the saved session.
   */
  async value (value: AuthValue): Promise<string> {
    return authReaderOf(this._options)(value)
  }

  /**
   * Describes the current state.
   * @returns The state.
   */
  async status (): Promise<AuthSessionPayload> {
    if (!this._options) {
      return { configured: false, providerName: null, signedIn: false, user: null, pendingLoginUrl: null, error: null }
    }

    const { signedIn, user } = await sessionStatus(this._options)
    return {
      configured: true,
      providerName: this._options.name,
      signedIn,
      user: user && { ...user, email: user.email ?? null },
      pendingLoginUrl: this._pendingLoginUrl,
      error: this._error
    }
  }

  /**
   * Signs the developer in: publishes the sign-in address for the interface to open, then waits for
   * the identity provider, and publishes why it failed if it does. A second request while one is
   * waiting does nothing.
   */
  async login (): Promise<void> {
    if (!this._options || this._signingIn) {
      return
    }

    this._signingIn = true
    this._error = null
    try {
      await login(this._options, async url => {
        this._pendingLoginUrl = url
        await this.publish()
      })
    } catch (error) {
      this._error = error instanceof Error ? error.message : String(error)
      logger.warn('Server', 'Auth', `Sign-in failed: ${this._error}`)
    } finally {
      this._signingIn = false
      this._pendingLoginUrl = null
      await this.publish()
    }
  }

  /**
   * Signs the developer out.
   */
  async logout (): Promise<void> {
    this._error = null
    await logout()
    await this.publish()
  }

  /**
   * Publishes the current state.
   */
  async publish (): Promise<void> {
    await this._publish(await this.status())
  }

  /**
   * Watches the directory of the saved session, written by renaming a new file over it, and
   * publishes the state shortly after it changes.
   */
  private watchSession (): void {
    if (this._watcher || !this._options) {
      return
    }

    const directory = path.dirname(sessionPath())
    const fileName = path.basename(sessionPath())
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this._watcher = watch(directory, (_event, changed) => {
      if (changed !== fileName) {
        return
      }

      if (this._changeTimer) {
        clearTimeout(this._changeTimer)
      }
      this._changeTimer = setTimeout(() => {
        this.publish().catch((error: unknown) => {
          logger.warn('Server', 'Auth', `Session state not published: ${error instanceof Error ? error.message : String(error)}`)
        })
      }, CHANGE_DELAY_MS)
    })
  }
}
