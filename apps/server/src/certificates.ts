import fs from 'node:fs/promises'
import path from 'node:path'
import { installCertificateFiles, installLego, legoCertificateFiles, legoRunArgs, readCertificate } from '@appsys-sas/devtool-certs'
import type { CertificatePayload, LoadBalancerCertificate, RuntimeConfig } from '@appsys-sas/devtool-shared'
import { logger } from '@appsys-sas/devtool-shared'
import type { CommandAutomation } from './command-automation.js'
import type { CommandStreamHooks } from './command-stream.js'
import { certificateAutomationKey } from './configure.js'
import type { CommandStreamCreatePayload } from './types.js'

const DAY_MS = 24 * 60 * 60 * 1000
const AUTOMATIC_CHECK_MS = DAY_MS / 2

/** A renewal ready to run: its command, and what completes it once the command succeeded. */
export interface CertificateRenewal {
  args: string[]
  cwd: string
  /** Puts the new certificate and key where they are served. */
  finish: () => Promise<void>
}

/**
 * Prepares the renewal of a certificate: with lego, installs it and gives `lego run` with the options of
 * the configuration, forced when asked for, else renewing within the days the configuration gives;
 * with a command, gives it with the paths of the certificate and key. It runs in the folder of the certificate.
 * @param name The name of the certificate in the configuration.
 * @param certificate The certificate, renewed by its `acme`.
 * @param cacheFolder The cache folder of the devtool, holding lego and its storage.
 * @param forced Whether the certificate is renewed even when it is not due.
 * @param log Receives the progress of the installation of lego.
 * @returns The renewal.
 */
export async function prepareRenewal (
  name: string,
  certificate: LoadBalancerCertificate,
  cacheFolder: string,
  forced: boolean,
  log: (line: string) => void
): Promise<CertificateRenewal> {
  const acme = certificate.acme
  if (!acme) {
    throw new Error(`${name} declares no acme renewal`)
  }
  const cwd = path.dirname(certificate.crt)
  if (acme.command) {
    const args = acme.command.map(arg => arg.replaceAll('%{ADT:CRT}', certificate.crt).replaceAll('%{ADT:KEY}', certificate.key))
    return { args, cwd, finish: () => Promise.resolve() }
  }

  const executable = await installLego(path.join(cacheFolder, 'lego'), log)
  const storage = path.join(cacheFolder, 'acme', name)
  const renewal = forced ? ['--renew-force', '--no-random-sleep'] : ['--renew-days', String(acme.before)]
  return {
    args: [executable, 'run', '--path', storage, '--accept-tos', '--cert.name', name, ...legoRunArgs(acme.lego ?? {}), ...renewal],
    cwd,
    finish: () => installCertificateFiles(legoCertificateFiles(storage, name), { crt: certificate.crt, key: certificate.key })
  }
}

/** What the certificates need from the server. */
export interface CertificatesHost {
  /** Sends the state to every connected interface. */
  publish: (payload: CertificatePayload[]) => Promise<void>
  /** Starts a command in a terminal of the server. */
  run: (data: CommandStreamCreatePayload, hooks: CommandStreamHooks) => Promise<unknown>
  /** Reloads the configuration, the load balancer reading the certificates again. */
  reload: () => Promise<void>
  /** Gives the paths of the synchronized environment files among local files. */
  synchronizedPaths: (files: string[]) => string[]
}

/**
 * Certificates of the load balancer as the interface shows them, and their renewals: asked for from
 * the interface, or automatic before they expire, one at a time per certificate.
 */
export class DevtoolCertificates {
  private _certificates: Record<string, LoadBalancerCertificate> = {}
  private _automations: Record<string, CommandAutomation> = {}
  private _cacheFolder = ''
  private _items: CertificatePayload[] = []
  private readonly _renewals = new Map<string, NonNullable<CertificatePayload['renewal']>>()
  private readonly _errors = new Map<string, string>()
  /** Date of the last automatic renewal of each certificate. */
  private readonly _automaticAttempts = new Map<string, number>()
  private _timer: NodeJS.Timeout | null = null

  /**
   * @param _host What the certificates need from the server.
   */
  constructor (private readonly _host: CertificatesHost) {}

  /**
   * Takes the certificates of the configuration and reads them again.
   * @param config The runtime configuration.
   * @param automations The automations of the configuration.
   */
  async configure (config: RuntimeConfig, automations: Record<string, CommandAutomation>): Promise<void> {
    this._certificates = Object.fromEntries(Object.entries(config.loadBalancers).map(([domain, certificate]) => [domain.replace(/^\./, ''), certificate]))
    this._automations = automations
    this._cacheFolder = config.adt.cacheDir
    await this.refresh()
    if (this._timer) {
      this.renewDue()
    }
  }

  /**
   * Starts the automatic renewals: now, then twice a day.
   */
  start (): void {
    this._timer ??= setInterval(() => this.renewDue(), AUTOMATIC_CHECK_MS).unref()
    this.renewDue()
  }

  /**
   * Describes the certificates, as last read.
   * @returns The state.
   */
  state (): CertificatePayload[] {
    return this._items
  }

  /**
   * Renews a certificate now, even when it is not due.
   * @param name The name of the certificate in the configuration.
   * @param tag Identifies the command for the interface asking for it.
   */
  async renew (name: string, tag: string | null): Promise<void> {
    if (this._certificates[name]?.acme?.trigger === 'auto') {
      return
    }
    await this.startRenewal(name, true, tag)
  }

  /**
   * Starts the automatic renewal of each certificate that expires within its `before` days or cannot
   * be read, at most once a day each.
   */
  private renewDue (): void {
    const now = Date.now()
    for (const item of this._items) {
      const acme = this._certificates[item.name]?.acme
      if (!acme || acme.trigger === 'button' || this._renewals.has(item.name) || now - (this._automaticAttempts.get(item.name) ?? 0) < DAY_MS) {
        continue
      }
      if (item.expiresAt && Date.parse(item.expiresAt) - now > acme.before * DAY_MS) {
        continue
      }
      this._automaticAttempts.set(item.name, now)
      void this.startRenewal(item.name, false, null)
    }
  }

  /**
   * Prepares then starts the renewal of a certificate in a terminal, unless one runs already.
   * @param name The name of the certificate in the configuration.
   * @param forced Whether the certificate is renewed even when it is not due.
   * @param tag Identifies the command for the interface asking for it.
   */
  private async startRenewal (name: string, forced: boolean, tag: string | null): Promise<void> {
    const certificate = this._certificates[name]
    if (!certificate?.acme || this._renewals.has(name)) {
      return
    }

    this._renewals.set(name, 'installing')
    this._errors.delete(name)
    await this.publish()
    try {
      const renewal = await prepareRenewal(name, certificate, this._cacheFolder, forced, line => logger.info('Certificates', name, line))
      this._renewals.set(name, 'running')
      await this.publish()
      await this._host.run(
        { args: renewal.args, env: certificate.acme.env, name: `Renew ${name}`, notifications: true, options: { cwd: renewal.cwd, ...(tag ? { tag } : {}) } },
        { automation: this._automations[certificateAutomationKey(name)] ?? null, onExit: exitCode => void this.finishRenewal(name, exitCode, renewal) }
      )
    } catch (error) {
      this._renewals.delete(name)
      this._errors.set(name, error instanceof Error ? error.message : String(error))
      await this.publish()
    }
  }

  /**
   * Completes a renewal whose command ended: puts the new files in place and reloads the configuration
   * when it succeeded, keeps why it failed otherwise.
   * @param name The name of the certificate in the configuration.
   * @param exitCode The exit code of the command, -1 when it was stopped.
   * @param renewal The renewal.
   */
  private async finishRenewal (name: string, exitCode: number, renewal: CertificateRenewal): Promise<void> {
    this._renewals.delete(name)
    if (exitCode !== 0) {
      this._errors.set(name, exitCode === -1 ? 'renewal stopped' : `renewal exited with code ${exitCode}`)
      await this.publish()
      return
    }
    try {
      await renewal.finish()
      await this._host.reload()
    } catch (error) {
      this._errors.set(name, error instanceof Error ? error.message : String(error))
      await this.publish()
    }
  }

  /**
   * Reads the certificates again and sends their state.
   */
  private async refresh (): Promise<void> {
    const items: CertificatePayload[] = []
    for (const [name, certificate] of Object.entries(this._certificates)) {
      const content = certificate.crt.trimStart().startsWith('-----BEGIN ') ? certificate.crt : await fs.readFile(certificate.crt, 'utf-8').catch(() => '')
      const info = readCertificate(content)
      items.push({
        name,
        expiresAt: info?.expiresAt ?? null,
        issuer: info?.issuer ?? null,
        error: null,
        trigger: certificate.acme?.trigger ?? null,
        warnDays: certificate.acme && certificate.acme.trigger !== 'button' ? certificate.acme.before : certificate.warn,
        renewal: null,
        push: certificate.acme ? this._host.synchronizedPaths([certificate.crt, certificate.key]) : []
      })
    }
    this._items = items.sort((left, right) => left.name.localeCompare(right.name))
    await this.publish()
  }

  /**
   * Sends the state, with the renewals running and the reasons of the failed ones, else why a
   * certificate cannot be read.
   */
  private async publish (): Promise<void> {
    this._items = this._items.map(item => ({
      ...item,
      renewal: this._renewals.get(item.name) ?? null,
      error: this._errors.get(item.name) ?? (item.expiresAt ? null : 'no readable certificate')
    }))
    await this._host.publish(this._items)
  }
}
