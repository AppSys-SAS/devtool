<script setup lang="ts">
import type { McpAnswer, McpRequestPayload } from '@appsys/devtool-shared'
import { Button } from '@/components/ui/button'
import { ANSWERS } from '@/lib/mcp'

defineProps<{
  grantable: McpRequestPayload['grantable']
  /** Whether allowing once is offered, accepting a client lasting at least for its session. */
  once: boolean
  /** Whether allowing is impossible, a required input being missing. */
  blocked?: boolean
}>()

const emit = defineEmits<{
  answer: [answer: McpAnswer]
}>()
</script>

<template>
  <div class="flex flex-wrap justify-end gap-2">
    <Button
      size="sm"
      variant="outline"
      class="text-destructive"
      @click="emit('answer', 'deny')"
    >
      {{ ANSWERS.deny }}
    </Button>
    <Button
      v-if="grantable.always"
      size="sm"
      variant="outline"
      :disabled="blocked"
      title="Never asked again, kept in the cache folder until revoked"
      @click="emit('answer', 'always')"
    >
      {{ ANSWERS.always }}
    </Button>
    <Button
      v-if="grantable.session"
      size="sm"
      :variant="once ? 'outline' : 'default'"
      :disabled="blocked"
      title="Not asked again until the agent disconnects"
      @click="emit('answer', 'session')"
    >
      {{ ANSWERS.session }}
    </Button>
    <Button
      v-if="once"
      size="sm"
      :disabled="blocked"
      @click="emit('answer', 'once')"
    >
      {{ ANSWERS.once }}
    </Button>
  </div>
</template>
