<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { Loader2, RefreshCw, ShieldCheck, TriangleAlert } from '@lucide/vue'
import type { CertificatePayload } from '@appsys/devtool-shared'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { expiresWithin, expiryClass, expiryLabel } from '@/lib/expiry'
import certificatesStore from '@/stores/certificates'
import commandRunsStore from '@/stores/command-runs'
import configStore from '@/stores/config'
import wsStore from '@/stores/ws'

const certificates = certificatesStore.items

/** The renewal this interface asked for, followed until it ends. */
const pending = shallowRef<{ name: string, tag: string, started: boolean } | null>(null)
const pushOffer = shallowRef<{ name: string, paths: string[] } | null>(null)
const pushOpen = computed({
  get: () => pushOffer.value !== null && commandRunsStore.current.value === null,
  set: open => {
    if (!open) {
      pushOffer.value = null
    }
  }
})

watch(certificates, items => {
  const renewal = pending.value
  const item = renewal ? items.find(certificate => certificate.name === renewal.name) : undefined
  if (!renewal || !item) {
    return
  }
  if (item.renewal) {
    pending.value = { ...renewal, started: true }
    return
  }
  if (!renewal.started) {
    return
  }
  pending.value = null
  const ran = configStore.commandStreams.value.some(stream => stream.tag === renewal.tag)
  if (item.error) {
    if (!ran) {
      commandRunsStore.close()
    }
    return
  }
  if (item.push.length) {
    pushOffer.value = { name: item.name, paths: item.push }
  }
})

/**
 * Warns about a certificate that expires within its warning days and is not renewing.
 * @param certificate The certificate.
 * @returns The warning, null when there is none.
 */
function warning (certificate: CertificatePayload): string | null {
  if (!certificate.expiresAt || certificate.renewal || !expiresWithin(certificate.expiresAt, certificate.warnDays)) {
    return null
  }
  if (certificate.trigger === 'auto' || certificate.trigger === 'both') {
    return 'The automatic renewal has not succeeded yet.'
  }
  return certificate.trigger === 'button' ? 'Renew it soon.' : 'Replace it soon.'
}

/**
 * Says whether a certificate offers its renewal button.
 * @param certificate The certificate.
 * @returns True when it is renewed from its button.
 */
function renewable (certificate: CertificatePayload): boolean {
  return certificate.trigger === 'button' || certificate.trigger === 'both'
}

/**
 * Renews a certificate now, its output shown in the command dialog.
 * @param certificate The certificate.
 */
function renew (certificate: CertificatePayload): void {
  const tag = commandRunsStore.show(`Renew ${certificate.name}`)
  pending.value = { name: certificate.name, tag, started: false }
  wsStore.certificateRenew(certificate.name, tag)
}

/**
 * Sends the renewed certificate and key to their environment backends.
 */
function push (): void {
  if (pushOffer.value) {
    wsStore.envRun('push', pushOffer.value.paths.map(path => ({ path, tables: null, keys: null })))
  }
}
</script>

<template>
  <Card
    v-if="certificates.length"
    class="max-w-3xl"
  >
    <CardHeader>
      <CardTitle>Certificates</CardTitle>
      <CardDescription>Certificates the load balancer serves.</CardDescription>
    </CardHeader>
    <CardContent class="space-y-2">
      <div
        v-for="certificate in certificates"
        :key="certificate.name"
        class="flex items-center gap-3 rounded-md border px-3 py-2"
      >
        <ShieldCheck class="size-4 shrink-0 text-muted-foreground" />
        <div class="min-w-0 flex-1">
          <p class="truncate font-mono text-sm">
            {{ certificate.name }}
          </p>
          <p class="truncate text-xs text-muted-foreground">
            <template v-if="certificate.expiresAt">
              <span :class="expiryClass(certificate.expiresAt, certificate.warnDays)">{{ expiryLabel(certificate.expiresAt) }}</span>
              <template v-if="certificate.issuer">
                · {{ certificate.issuer }}
              </template>
            </template>
            <span
              v-if="certificate.error"
              class="text-destructive"
            >
              <template v-if="certificate.expiresAt"> · </template>{{ certificate.error }}
            </span>
          </p>
          <p
            v-if="warning(certificate)"
            class="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
          >
            <TriangleAlert class="size-3 shrink-0" />
            {{ warning(certificate) }}
          </p>
        </div>
        <Badge
          v-if="certificate.trigger === 'auto' || certificate.trigger === 'both'"
          variant="outline"
        >
          auto
        </Badge>
        <Button
          v-if="renewable(certificate)"
          size="sm"
          variant="outline"
          class="gap-1.5"
          :disabled="certificate.renewal !== null"
          @click="renew(certificate)"
        >
          <Loader2
            v-if="certificate.renewal"
            class="size-3.5 animate-spin"
          />
          <RefreshCw
            v-else
            class="size-3.5"
          />
          {{ certificate.renewal === "installing" ? "Installing lego…" : "Renew" }}
        </Button>
      </div>
    </CardContent>
  </Card>

  <ConfirmDialog
    v-model:open="pushOpen"
    title="Push to the environment?"
    confirm-label="Push"
    @confirm="push"
  >
    {{ pushOffer?.name }} is renewed. Send {{ pushOffer?.paths.join(" and ") }} to their environment backends, where the others pull them.
  </ConfirmDialog>
</template>
