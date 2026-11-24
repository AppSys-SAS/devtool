<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import type { McpGrantPayload } from '@appsys/devtool-shared'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import mcpStore from '@/stores/mcp'

const grants = computed(() => mcpStore.state.value?.grants ?? [])
const scopes = computed(() => [
  { scope: 'session' as const, title: 'For the session', empty: 'Nothing granted until an agent disconnects.', grants: grants.value.filter(grant => grant.scope === 'session') },
  { scope: 'always' as const, title: 'Always', empty: 'Nothing granted for good.', grants: grants.value.filter(grant => grant.scope === 'always') }
])
const clearing = shallowRef<'session' | 'always'>('session')
const clearOpen = shallowRef(false)

/**
 * Asks whether to remove every grant of a scope.
 * @param scope Whether the grants last for a session or always.
 */
function askClear (scope: 'session' | 'always'): void {
  clearing.value = scope
  clearOpen.value = true
}

/**
 * Describes when and for whom a grant was given.
 * @param grant The grant.
 * @returns The description.
 */
function granted (grant: McpGrantPayload): string {
  return `${grant.client ? mcpStore.clientName(grant.client) : 'any client'} ·${new Date(grant.date).toLocaleString()}`
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>Grants</CardTitle>
      <CardDescription>Calls agents make without asking. A refusal of the configuration always prevails.</CardDescription>
    </CardHeader>
    <CardContent class="grid gap-4 md:grid-cols-2">
      <div
        v-for="item in scopes"
        :key="item.scope"
        class="space-y-2"
      >
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-sm font-medium">
            {{ item.title }}
          </h3>
          <Button
            v-if="item.grants.length"
            size="sm"
            variant="ghost"
            class="h-7 text-destructive"
            @click="askClear(item.scope)"
          >
            Remove all
          </Button>
        </div>
        <p
          v-if="!item.grants.length"
          class="text-sm text-muted-foreground"
        >
          {{ item.empty }}
        </p>
        <div
          v-for="grant in item.grants"
          :key="`${grant.session}/${grant.key}`"
          class="flex items-center gap-2 rounded-md border px-3 py-2"
        >
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm">
              {{ grant.label }}
            </p>
            <p class="truncate text-xs text-muted-foreground">
              <code>{{ grant.key }}</code> · {{ granted(grant) }}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            class="h-7 text-destructive"
            @click="mcpStore.revoke(grant.key, grant.scope, grant.session)"
          >
            Remove
          </Button>
        </div>
      </div>
    </CardContent>
  </Card>

  <ConfirmDialog
    v-model:open="clearOpen"
    :title="`Remove every grant ${clearing === 'always' ? 'kept always' : 'of the sessions'}?`"
    confirm-label="Remove all"
    @confirm="mcpStore.revoke(null, clearing)"
  >
    The agents are asked again for these calls.
  </ConfirmDialog>
</template>
