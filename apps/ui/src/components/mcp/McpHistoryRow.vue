<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import { RouterLink } from 'vue-router'
import { Icon } from '@iconify/vue'
import { ChevronRight, CircleAlert, CircleCheck, Hourglass, SquareTerminal } from '@lucide/vue'
import type { McpGrantPayload, McpHistoryEntry } from '@appsys/devtool-shared'
import McpDetailList from '@/components/mcp/McpDetailList.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DECISIONS } from '@/lib/mcp'
import mcpStore from '@/stores/mcp'

/** Below this, the time spent in the approvals is not worth showing. */
const NOTABLE_WAIT_MS = 300

const props = defineProps<{
  entry: McpHistoryEntry
  /** The grants of the key of the call. */
  grants: McpGrantPayload[]
  /** Whether the session of the call is still open. */
  sessionOpen: boolean
  /** Whether its terminal still exists. */
  terminalOpen: boolean
}>()

const emit = defineEmits<{
  grant: [scope: 'session' | 'always']
  revoke: [grant: McpGrantPayload]
}>()

const expanded = shallowRef(false)
const waited = computed(() => ((props.entry.waited ?? 0) >= NOTABLE_WAIT_MS ? props.entry.waited : 0))

/**
 * Writes a duration in milliseconds or seconds.
 * @param milliseconds The duration.
 * @returns The duration with its unit.
 */
function formatDuration (milliseconds: number): string {
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`
}
</script>

<template>
  <div class="rounded-md border">
    <button
      type="button"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent/40"
      @click="expanded = !expanded"
    >
      <ChevronRight
        class="size-3 shrink-0 text-muted-foreground transition-transform"
        :class="{ 'rotate-90': expanded }"
      />
      <span class="w-16 shrink-0 tabular-nums text-muted-foreground">{{ new Date(entry.date).toLocaleTimeString() }}</span>
      <span
        class="flex w-28 shrink-0 items-center gap-1.5"
        :title="entry.client"
      >
        <Icon
          :icon="mcpStore.clientIcon(entry.client)"
          class="size-3.5 shrink-0 text-muted-foreground"
        />
        <span class="truncate">{{ mcpStore.clientName(entry.client) }}</span>
      </span>
      <code class="w-36 shrink-0 truncate">{{ entry.tool }}</code>
      <span class="min-w-0 flex-1 truncate font-mono text-muted-foreground">{{ entry.target ?? "" }}</span>
      <Badge
        v-if="entry.action"
        variant="outline"
        class="hidden sm:inline-flex"
      >
        {{ entry.action }}
      </Badge>
      <Badge :class="DECISIONS[entry.decision].class">
        {{ DECISIONS[entry.decision].label }}
      </Badge>
      <CircleCheck
        v-if="entry.ok"
        class="size-3.5 shrink-0 text-emerald-600"
      />
      <CircleAlert
        v-else
        class="size-3.5 shrink-0 text-destructive"
      />
      <span
        class="flex w-20 shrink-0 items-center justify-end gap-1 tabular-nums text-muted-foreground"
        :title="waited ? `${formatDuration(waited)} waiting for an answer` : undefined"
      >
        <Hourglass
          v-if="waited"
          class="size-3 text-amber-600"
        />
        {{ formatDuration(entry.duration) }}
      </span>
    </button>

    <div
      v-if="expanded"
      class="space-y-2 border-t px-3 py-2 text-xs"
    >
      <p
        v-if="entry.acceptance"
        class="text-muted-foreground"
      >
        {{ mcpStore.clientName(entry.client) }} was accepted {{ entry.acceptance === "always" ? "always" : "for its session" }} during this call.
      </p>
      <p
        v-if="waited"
        class="text-muted-foreground"
      >
        {{ formatDuration(waited) }} of {{ formatDuration(entry.duration) }} spent waiting for an answer.
      </p>
      <p
        v-if="entry.message"
        :class="entry.ok ? 'text-muted-foreground' : 'text-destructive'"
      >
        {{ entry.message }}
      </p>
      <p
        v-if="entry.reason"
        class="text-muted-foreground"
      >
        Refused by <code>{{ entry.reason }}</code>
      </p>
      <div class="space-y-1">
        <p class="font-medium text-muted-foreground">
          Arguments
        </p>
        <McpDetailList
          v-if="entry.input?.length"
          :details="entry.input"
        />
        <p
          v-else
          class="text-muted-foreground"
        >
          None.
        </p>
      </div>
      <div
        v-if="entry.details.length"
        class="space-y-1"
      >
        <p class="font-medium text-muted-foreground">
          Request
        </p>
        <McpDetailList :details="entry.details" />
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <RouterLink
          v-if="entry.terminal && terminalOpen"
          :to="{ name: 'stream', params: { streamSlug: entry.terminal } }"
          class="mr-auto flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <SquareTerminal class="size-3.5" />
          Open the terminal
        </RouterLink>
        <template v-if="entry.grantKey && entry.decision !== 'config' && entry.decision !== 'auto'">
          <span class="ml-auto font-mono text-muted-foreground">{{ entry.grantLabel ?? entry.grantKey }}</span>
          <Button
            v-for="grant in grants"
            :key="`${grant.scope}/${grant.session}`"
            size="sm"
            variant="ghost"
            class="h-7 text-destructive"
            @click="emit('revoke', grant)"
          >
            Revoke ({{ grant.scope }})
          </Button>
          <Button
            v-if="sessionOpen && !grants.some((grant) => grant.scope === 'session' && grant.session === entry.session)"
            size="sm"
            variant="outline"
            class="h-7"
            @click="emit('grant', 'session')"
          >
            Allow for the session
          </Button>
          <Button
            v-if="!grants.some((grant) => grant.scope === 'always')"
            size="sm"
            variant="outline"
            class="h-7"
            @click="emit('grant', 'always')"
          >
            Always allow
          </Button>
        </template>
      </div>
    </div>
  </div>
</template>
