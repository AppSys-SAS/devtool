<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { RouterView } from 'vue-router'
import { useFavicon, useTitle } from '@vueuse/core'
import AppSidebar from '@/components/AppSidebar.vue'
import CommandDialog from '@/components/CommandDialog.vue'
import CommandInputsDialog from '@/components/CommandInputsDialog.vue'
import EmbedFrames from '@/components/EmbedFrames.vue'
import McpRequestDialog from '@/components/mcp/McpRequestDialog.vue'
import McpToasts from '@/components/mcp/McpToasts.vue'
import SecretPromptDialog from '@/components/SecretPromptDialog.vue'
import commandRunsStore from '@/stores/command-runs'
import configStore from '@/stores/config'
import layoutStore from '@/stores/layout'
import mcpStore from '@/stores/mcp'
import wsStore from '@/stores/ws'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

useTitle(
  computed(() => {
    const waiting = mcpStore.state.value?.pending.length ?? 0
    return waiting ? `(${waiting}) ${configStore.displayName.value}` : configStore.displayName.value
  })
)
useFavicon(computed(() => `/app-icon?loaded=${configStore.loadedAt.value}`))

onMounted(() => {
  if (!wsStore.connected.value && !wsStore.loading.value) {
    wsStore.connect()
  }
})
</script>

<template>
  <div
    v-if="!wsStore.connected.value"
    class="flex h-full w-full items-center justify-center bg-muted/30 p-6"
  >
    <Card class="w-full max-w-lg">
      <CardHeader>
        <CardTitle>Server</CardTitle>
        <CardDescription v-if="wsStore.loading.value">
          Connecting to server...
        </CardDescription>
        <CardDescription v-else>
          {{ wsStore.error.value || "Disconnected from server" }}
        </CardDescription>
      </CardHeader>
      <CardContent v-if="!wsStore.loading.value">
        <Button @click="wsStore.connect()">
          Try To Reconnect
        </Button>
      </CardContent>
    </Card>
  </div>
  <div
    v-else
    class="flex h-full w-full overflow-hidden"
  >
    <AppSidebar
      v-show="layoutStore.isVisible('left')"
      class="h-full w-80 shrink-0 border-r"
    />
    <main class="min-w-0 flex-1 overflow-hidden">
      <RouterView />
    </main>
    <EmbedFrames />
    <CommandDialog
      v-if="commandRunsStore.current.value"
      :key="commandRunsStore.current.value.tag"
      :tag="commandRunsStore.current.value.tag"
      :title="commandRunsStore.current.value.title"
      @finished="commandRunsStore.current.value.onFinished?.()"
      @closed="commandRunsStore.close()"
    />
    <CommandInputsDialog />
    <McpRequestDialog />
    <McpToasts />
    <SecretPromptDialog />
  </div>
</template>
