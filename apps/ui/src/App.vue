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
import SidebarFrame from '@/components/SidebarFrame.vue'
import SidebarToggle from '@/components/SidebarToggle.vue'
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
    <SidebarFrame
      side="left"
      class="w-80 border-r bg-card"
    >
      <AppSidebar class="min-w-0 flex-1" />
    </SidebarFrame>
    <div
      class="flex min-w-0 flex-1 flex-col"
      :inert="layoutStore.covers('left')"
    >
      <header
        v-if="layoutStore.narrow.value"
        class="flex h-11 shrink-0 items-center gap-2 border-b bg-card px-2"
        :inert="layoutStore.opened.value !== null"
      >
        <SidebarToggle
          side="left"
          in-bar
        />
        <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ configStore.displayName.value }}</span>
        <SidebarToggle
          side="right"
          in-bar
        />
      </header>
      <main class="min-h-0 flex-1 overflow-hidden">
        <RouterView />
      </main>
    </div>
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
