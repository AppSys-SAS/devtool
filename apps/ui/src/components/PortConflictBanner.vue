<script setup lang="ts">
import { TriangleAlert } from '@lucide/vue'
import type { PortConflict, PortConflictAction } from '@appsys/devtool-shared'
import { Button } from '@/components/ui/button'

defineProps<{
  conflict: PortConflict
}>()

const emit = defineEmits<{
  resolve: [action: PortConflictAction]
}>()
</script>

<template>
  <div class="mx-3 mt-2 flex flex-wrap items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
    <TriangleAlert class="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
    <div class="min-w-0 flex-1">
      <p class="font-medium">
        Port {{ conflict.port }} is already used by
      </p>
      <p
        v-for="owner in conflict.owners"
        :key="owner.pid"
        class="truncate font-mono text-xs text-muted-foreground"
        :title="owner.command"
      >
        {{ owner.command || "unknown process" }} (pid {{ owner.pid }})
      </p>
    </div>
    <div class="flex shrink-0 items-center gap-1">
      <Button
        size="sm"
        @click="emit('resolve', 'killAndRestart')"
      >
        Kill and restart
      </Button>
      <Button
        size="sm"
        variant="secondary"
        @click="emit('resolve', 'kill')"
      >
        Kill
      </Button>
      <Button
        size="sm"
        variant="ghost"
        @click="emit('resolve', 'dismiss')"
      >
        Dismiss
      </Button>
    </div>
  </div>
</template>
