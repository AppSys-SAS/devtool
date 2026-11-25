import { ref } from 'vue'
import type { CertificatePayload } from '@appsys-sas/devtool-shared'

/**
 * Certificates of the load balancer as the server describes them.
 */
class CertificatesStore {
  items = ref<CertificatePayload[]>([])

  /**
   * Takes the state sent by the server.
   * @param payload The certificates, empty once disconnected from the server.
   */
  load (payload: CertificatePayload[]): void {
    this.items.value = payload
  }
}

export default new CertificatesStore()
