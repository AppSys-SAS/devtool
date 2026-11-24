<script setup lang="ts">
import { useClipboard } from '@vueuse/core'
import { Check, Copy } from '@lucide/vue'
import { Button } from '@/components/ui/button'

defineProps<{
  text: string
}>()

const { copy, copied } = useClipboard({ copiedDuring: 1500 })
</script>

<template>
  <div class="flex items-start gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-3">
    <pre class="min-w-0 flex-1 overflow-x-auto py-1.5 text-xs"><code>{{ text }}</code></pre>
    <Button
      size="icon-sm"
      variant="ghost"
      title="Copy"
      @click="copy(text)"
    >
      <Check
        v-if="copied"
        class="size-3.5"
      />
      <Copy
        v-else
        class="size-3.5"
      />
    </Button>
  </div>
</template>
