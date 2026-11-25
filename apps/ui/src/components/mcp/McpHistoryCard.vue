<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import { Trash2 } from '@lucide/vue'
import type { McpDecision, McpGrantPayload } from '@appsys-sas/devtool-shared'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import McpHistoryRow from '@/components/mcp/McpHistoryRow.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { DECISIONS } from '@/lib/mcp'
import configStore from '@/stores/config'
import mcpStore from '@/stores/mcp'

const ALL = '*'
const SHOWN = 300

const search = shallowRef('')
const client = shallowRef(ALL)
const tool = shallowRef(ALL)
const decision = shallowRef(ALL)
const clearOpen = shallowRef(false)

const history = mcpStore.history
const grants = computed(() => mcpStore.state.value?.grants ?? [])
const sessions = computed(() => new Set(mcpStore.state.value?.sessions.map(session => session.id)))
const terminals = computed(() => new Set(configStore.commandStreams.value.map(stream => stream.slug)))

/**
 * Lists the distinct values of a field of the history as options of a filter.
 * @param values The values.
 * @param label The label of the option matching everything.
 * @param name Gives the label of a value.
 * @returns The options.
 */
function options (values: string[], label: string, name: (value: string) => string = value => value): { label: string, value: string }[] {
  return [{ label, value: ALL }, ...[...new Set(values)].sort().map(value => ({ label: name(value), value }))]
}

/**
 * Grants again what a call asked.
 * @param historyId The call.
 * @param scope How long the grant lasts.
 */
function grant (historyId: string, scope: 'session' | 'always'): void {
  mcpStore.grant(historyId, scope)
}

/**
 * Removes a grant.
 * @param grant The grant.
 */
function revoke (grant: McpGrantPayload): void {
  mcpStore.revoke(grant.key, grant.scope, grant.session)
}

const clients = computed(() => options(history.value.map(entry => entry.client), 'Every client', name => mcpStore.clientName(name)))
const tools = computed(() => options(history.value.map(entry => entry.tool), 'Every tool'))
const decisions = [{ label: 'Every decision', value: ALL }, ...Object.entries(DECISIONS).map(([value, { label }]) => ({ label, value }))]

const entries = computed(() => {
  const text = search.value.trim().toLowerCase()
  return history.value
    .filter(
      entry =>
        (client.value === ALL || entry.client === client.value)
        && (tool.value === ALL || entry.tool === tool.value)
        && (decision.value === ALL || entry.decision === (decision.value as McpDecision))
        && (!text || [entry.target, entry.message, ...entry.details.map(detail => detail.value)].some(value => value?.toLowerCase().includes(text)))
    )
    .slice(-SHOWN)
    .reverse()
})
</script>

<template>
  <Card>
    <CardHeader class="flex flex-row items-start justify-between gap-3">
      <div class="space-y-1.5">
        <CardTitle>History</CardTitle>
        <CardDescription>Every call of the agents, the newest first. Unfold a call to allow it again for its session or always.</CardDescription>
      </div>
      <Button
        size="sm"
        variant="ghost"
        class="gap-1.5"
        :disabled="!history.length"
        @click="clearOpen = true"
      >
        <Trash2 class="size-3.5" />
        Clear
      </Button>
    </CardHeader>
    <CardContent class="space-y-3">
      <div class="grid gap-2 sm:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
        <Input
          v-model="search"
          placeholder="Search a command, file, text…"
          class="h-8 text-xs"
        />
        <Select
          v-model="client"
          :options="clients"
        />
        <Select
          v-model="tool"
          :options="tools"
        />
        <Select
          v-model="decision"
          :options="decisions"
        />
      </div>
      <p
        v-if="!entries.length"
        class="text-sm text-muted-foreground"
      >
        No call.
      </p>
      <div class="space-y-1">
        <McpHistoryRow
          v-for="entry in entries"
          :key="entry.id"
          :entry="entry"
          :grants="grants.filter((grant) => grant.key === entry.grantKey)"
          :session-open="sessions.has(entry.session)"
          :terminal-open="entry.terminal !== null && terminals.has(entry.terminal)"
          @grant="(scope) => grant(entry.id, scope)"
          @revoke="revoke"
        />
      </div>
    </CardContent>
  </Card>

  <ConfirmDialog
    v-model:open="clearOpen"
    title="Clear the history?"
    confirm-label="Clear"
    @confirm="mcpStore.clearHistory()"
  >
    Every call kept is removed, here and in the cache folder.
  </ConfirmDialog>
</template>
