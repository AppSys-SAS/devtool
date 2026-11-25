<script setup lang="ts">
import type { McpDetail } from '@appsys-sas/devtool-shared'

defineProps<{
  details: McpDetail[]
}>()
</script>

<template>
  <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
    <template
      v-for="(detail, index) in details"
      :key="index"
    >
      <dt class="text-muted-foreground">
        {{ detail.label }}
      </dt>
      <dd class="max-h-32 overflow-auto font-mono whitespace-pre-wrap break-all">
        {{ detail.value }}
      </dd>
    </template>
  </dl>
</template>
