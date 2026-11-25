import { randomUUID } from 'node:crypto'
import type { SecretRequestPayload } from '@appsys-sas/devtool-shared'

const ANSWER_TIMEOUT_MS = 5 * 60_000

/** A secret waiting for the developer to type it. */
interface PendingSecret {
  request: SecretRequestPayload
  resolve: (value: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Secrets the server asks the developer to type in the interface, such as the password of encrypted
 * files: each request is sent to every interface, the first answer wins and the others close it.
 */
export class SecretPrompts {
  private readonly _pending = new Map<string, PendingSecret>()

  /**
   * @param _send Sends a message to every connected interface.
   */
  constructor (private readonly _send: (type: 'secretRequest' | 'secretDone', data: SecretRequestPayload | { id: string }) => Promise<void>) {}

  /**
   * Asks the developer for a secret.
   * @param label What the secret unlocks.
   * @returns The secret typed; refused when the developer cancels or does not answer within 5 minutes.
   */
  async ask (label: string): Promise<string> {
    const request: SecretRequestPayload = { id: randomUUID(), label }
    const answer = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.answer(request.id, null, `nobody typed the secret of ${label} in time`)
      }, ANSWER_TIMEOUT_MS)
      this._pending.set(request.id, { request, resolve, reject, timer })
    })
    await this._send('secretRequest', request)
    return answer
  }

  /**
   * Takes the answer of an interface.
   * @param id The request.
   * @param value The secret typed, null when the developer cancelled.
   * @param reason Why the request ends without a secret.
   */
  async answer (id: string, value: string | null, reason = 'cancelled'): Promise<void> {
    const pending = this._pending.get(id)
    if (!pending) {
      return
    }
    this._pending.delete(id)
    clearTimeout(pending.timer)
    if (value === null) {
      pending.reject(new Error(`${pending.request.label}: ${reason}`))
    } else {
      pending.resolve(value)
    }
    await this._send('secretDone', { id })
  }

  /**
   * Lists the requests still waiting, for an interface that connects.
   * @returns The requests.
   */
  waiting (): SecretRequestPayload[] {
    return [...this._pending.values()].map(pending => pending.request)
  }
}
