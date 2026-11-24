<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import { useIntervalFn, useNow } from '@vueuse/core'
import { Icon } from '@iconify/vue'
import { Clock } from '@lucide/vue'
import type { CommandInputValue, McpAnswer, McpRequestPayload } from '@appsys/devtool-shared'
import CommandInputsForm from '@/components/CommandInputsForm.vue'
import McpAnswerButtons from '@/components/mcp/McpAnswerButtons.vue'
import McpDetailList from '@/components/mcp/McpDetailList.vue'
import { Badge } from '@/components/ui/badge'
import { findMcpCommand } from '@/lib/mcp'
import configStore from '@/stores/config'
import mcpStore from '@/stores/mcp'

const McpDiff = defineAsyncComponent(() => import('@/components/mcp/McpDiff.vue'))

const props = defineProps<{
  request: McpRequestPayload
}>()

const emit = defineEmits<{
  answer: [answer: McpAnswer, inputs: CommandInputValue[] | null]
}>()

const now = useNow({ scheduler: tick => useIntervalFn(tick, 1000) })
const remaining = computed(() => Math.max(0, Math.ceil((props.request.expiresAt - now.value.getTime()) / 1000)))
const command = computed(() => (props.request.command && props.request.inputs ? findMcpCommand(configStore.projects.value, props.request.command) : null))
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-2 text-xs">
      <Badge variant="secondary">
        <Icon :icon="mcpStore.clientIcon(request.client)" />
        {{ mcpStore.clientName(request.client) }}
      </Badge>
      <code class="text-muted-foreground">{{ request.tool }}</code>
      <Badge
        v-if="request.kind === 'client'"
        variant="outline"
      >
        new client
      </Badge>
      <Badge
        v-else-if="request.action"
        variant="outline"
      >
        {{ request.action }}
      </Badge>
      <span
        class="ml-auto flex items-center gap-1 tabular-nums"
        :class="remaining <= 15 ? 'text-destructive' : 'text-muted-foreground'"
        title="Denied when nobody answers in time"
      >
        <Clock class="size-3" />
        {{ remaining }}s
      </span>
    </div>

    <McpDetailList
      v-if="request.details.length"
      :details="request.details"
    />

    <div
      v-if="request.keys.length"
      class="flex flex-wrap items-center gap-1 text-xs"
    >
      <span class="text-muted-foreground">Keys</span>
      <kbd
        v-for="(key, index) in request.keys"
        :key="index"
        class="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px]"
      >{{ key }}</kbd>
    </div>

    <McpDiff
      v-if="request.diff"
      :path="request.diff.path"
      :before="request.diff.before"
      :after="request.diff.after"
    />

    <CommandInputsForm
      v-if="command"
      :command="command"
      :initial="request.inputs"
    >
      <template #actions="{ inputs, missing }">
        <McpAnswerButtons
          :grantable="request.grantable"
          :once="request.kind === 'permission'"
          :blocked="missing"
          @answer="(answer) => emit('answer', answer, inputs)"
        />
      </template>
    </CommandInputsForm>
    <McpAnswerButtons
      v-else
      :grantable="request.grantable"
      :once="request.kind === 'permission'"
      @answer="(answer) => emit('answer', answer, null)"
    />
  </div>
</template>
