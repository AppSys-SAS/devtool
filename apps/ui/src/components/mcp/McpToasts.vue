<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { X } from '@lucide/vue'
import { ToastClose, ToastDescription, ToastProvider, ToastRoot, ToastTitle, ToastViewport } from 'reka-ui'
import { computed } from 'vue'
import layoutStore from '@/stores/layout'
import mcpStore from '@/stores/mcp'

const LEVEL_CLASSES = {
  info: 'border-border',
  warning: 'border-amber-500/60',
  error: 'border-destructive/60'
} as const

const messages = mcpStore.messages
const covered = computed(() => layoutStore.covers('left') || layoutStore.covers('right'))

/**
 * Hides a message once its toast closes.
 * @param id The message.
 * @param open Whether the toast is still open.
 */
function closed (id: string, open: boolean): void {
  if (!open) {
    mcpStore.dismissMessage(id)
  }
}
</script>

<template>
  <ToastProvider :duration="10000">
    <ToastRoot
      v-for="message in covered ? [] : messages"
      :key="message.id"
      class="flex items-start gap-3 rounded-lg border bg-background p-3 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-80 data-[state=open]:slide-in-from-bottom-4"
      :class="LEVEL_CLASSES[message.level]"
      @update:open="(open) => closed(message.id, open)"
    >
      <Icon
        :icon="mcpStore.clientIcon(message.client)"
        class="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <div class="min-w-0 flex-1">
        <ToastTitle class="text-xs font-medium text-muted-foreground">
          {{ mcpStore.clientName(message.client) }}
        </ToastTitle>
        <ToastDescription class="text-sm whitespace-pre-wrap break-words">
          {{ message.message }}
        </ToastDescription>
      </div>
      <ToastClose class="text-muted-foreground hover:text-foreground">
        <X class="size-3.5" />
      </ToastClose>
    </ToastRoot>
    <ToastViewport class="fixed right-4 bottom-4 z-[60] flex w-96 max-w-[calc(100%-2rem)] flex-col gap-2" />
  </ToastProvider>
</template>
