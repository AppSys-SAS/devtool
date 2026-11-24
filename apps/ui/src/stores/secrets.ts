import { computed, shallowRef } from 'vue'
import type { SecretRequestPayload } from '@appsys/devtool-shared'
import wsStore from './ws'

/**
 * Secrets the server asks the developer to type, such as the password of encrypted files.
 */
class SecretsStore {
  waiting = shallowRef<SecretRequestPayload[]>([])

  /** The request the dialog asks, the oldest one waiting. */
  current = computed<SecretRequestPayload | null>(() => this.waiting.value[0] ?? null)

  /**
   * Keeps a request sent by the server.
   * @param request The request.
   */
  add (request: SecretRequestPayload): void {
    if (!this.waiting.value.some(candidate => candidate.id === request.id)) {
      this.waiting.value = [...this.waiting.value, request]
    }
  }

  /**
   * Forgets a request answered, here or in another interface.
   * @param id The request.
   */
  remove (id: string): void {
    this.waiting.value = this.waiting.value.filter(request => request.id !== id)
  }

  /**
   * Sends the secret typed, or the refusal, for a request.
   * @param id The request.
   * @param value The secret, null when the developer cancels.
   */
  answer (id: string, value: string | null): void {
    wsStore.send('secretAnswer', { id, value })
    this.remove(id)
  }

  /**
   * Forgets every request, once disconnected from the server.
   */
  reset (): void {
    this.waiting.value = []
  }
}

export default new SecretsStore()
