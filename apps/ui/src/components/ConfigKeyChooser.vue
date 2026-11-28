<script setup lang="ts">
import { computed, ref } from 'vue'
import { Eye, EyeOff } from '@lucide/vue'
import type { EnvironmentKeyPayload, EnvironmentKeyValuePayload } from '@appsys-sas/devtool-shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Side = 'local' | 'remote'

interface BranchRow {
  kind: 'branch'
  id: string
  name: string
  depth: number
  leaves: string[]
}

interface LeafRow {
  kind: 'leaf'
  id: string
  name: string
  depth: number
  entry: EnvironmentKeyPayload
}

const SENSITIVE_NAME = /secret|password|passwd|token|key|private|credential/i
const MAX_VALUE_LENGTH = 60

const props = defineProps<{
  entries: EnvironmentKeyPayload[]
  defaultSide: Side
  /** The name of the backend holding the remote copy. */
  remoteName: string
}>()

const choices = defineModel<Record<string, Side>>({ required: true })
const revealed = ref<Record<string, boolean>>({})

/**
 * Identifies a key by its path.
 * @param path The path of the key.
 * @returns A stable identifier.
 */
function idOf (path: string[]): string {
  return JSON.stringify(path)
}

const rows = computed(() => {
  const result: (BranchRow | LeafRow)[] = []
  const branches = new Map<string, BranchRow>()
  for (const entry of props.entries) {
    for (let depth = 0; depth < entry.path.length - 1; depth += 1) {
      const id = idOf(entry.path.slice(0, depth + 1))
      let branch = branches.get(id)
      if (!branch) {
        branch = { kind: 'branch', id, name: entry.path[depth], depth, leaves: [] }
        branches.set(id, branch)
        result.push(branch)
      }
      branch.leaves.push(idOf(entry.path))
    }
    result.push({ kind: 'leaf', id: idOf(entry.path), name: entry.path.at(-1) ?? '', depth: entry.path.length - 1, entry })
  }

  return result
})

/**
 * Gives the side chosen for a key.
 * @param id The identifier of the key.
 * @returns The side.
 */
function sideOf (id: string): Side {
  return choices.value[id] ?? props.defaultSide
}

/**
 * Chooses a side for some keys.
 * @param ids The identifiers of the keys.
 * @param side The side.
 */
function choose (ids: string[], side: Side): void {
  choices.value = { ...choices.value, ...Object.fromEntries(ids.map(id => [id, side])) }
}

/**
 * Gives the indentation of a key, one step deeper for each nesting level, its steps narrowing with
 * its cell so that the deepest keys keep most of it.
 * @param depth The nesting depth of the key.
 * @returns The CSS padding.
 */
function indentOf (depth: number): string {
  return `min(${depth}rem, ${Math.min(depth * 6, 30)}%)`
}

/**
 * Tells which side all the keys of a branch take.
 * @param branch The branch.
 * @returns The common side, or "mixed".
 */
function branchSide (branch: BranchRow): Side | 'mixed' {
  const sides = new Set(branch.leaves.map(sideOf))
  return sides.size === 1 ? [...sides][0] : 'mixed'
}

/**
 * Tells whether a value holds keys named like secrets.
 * @param value The value.
 * @returns True when one of its keys looks like a secret.
 */
function holdsSecrets (value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  return Object.entries(value).some(([key, child]) => SENSITIVE_NAME.test(key) || holdsSecrets(child))
}

/**
 * Tells whether the values of a key must be masked.
 * @param row The key row.
 * @returns True for a key named like a secret, or holding such keys.
 */
function isSensitive (row: LeafRow): boolean {
  return SENSITIVE_NAME.test(row.name) || holdsSecrets(row.entry.local.value) || holdsSecrets(row.entry.remote.value)
}

/**
 * Formats a value for its cell.
 * @param value The value of one copy.
 * @returns The full text and the shortened text.
 */
function formatValue (value: EnvironmentKeyValuePayload): { full: string, short: string } {
  if (!value.present) {
    return { full: 'absent', short: '— absent' }
  }

  const full = typeof value.value === 'string' ? value.value : JSON.stringify(value.value)
  const firstLine = full.split('\n')[0]
  const short = firstLine.length > MAX_VALUE_LENGTH || firstLine !== full ? `${firstLine.slice(0, MAX_VALUE_LENGTH)}…` : firstLine
  return { full, short }
}

/**
 * Labels how a key differs.
 * @param entry The key.
 * @returns The label.
 */
function differenceLabel (entry: EnvironmentKeyPayload): string {
  if (!entry.local.present) {
    return `Only on ${props.remoteName}`
  }

  return entry.remote.present ? 'Changed' : 'Only local'
}

/**
 * Shows or hides the values of every masked key at once.
 */
function toggleAllRevealed (): void {
  const reveal = !allRevealed.value
  revealed.value = Object.fromEntries(sensitiveIds.value.map(id => [id, reveal]))
}

const allIds = computed(() => props.entries.map(entry => idOf(entry.path)))
const remoteCount = computed(() => allIds.value.filter(id => sideOf(id) === 'remote').length)
const sensitiveIds = computed(() => rows.value.flatMap(row => (row.kind === 'leaf' && isSensitive(row) ? [row.id] : [])))
const allRevealed = computed(() => sensitiveIds.value.length > 0 && sensitiveIds.value.every(id => revealed.value[id]))
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <span class="text-xs text-muted-foreground">
        <template v-if="entries.length === 0">Both copies are identical.</template>
        <template v-else>
          {{ entries.length }} differing {{ entries.length > 1 ? "keys" : "key" }}: {{ remoteCount }} from {{ remoteName }}, {{ entries.length - remoteCount }} local
        </template>
      </span>
      <div
        v-if="entries.length > 0"
        class="flex flex-wrap gap-1"
      >
        <Button
          v-if="sensitiveIds.length > 0"
          size="sm"
          variant="ghost"
          class="h-7 gap-1 px-2 text-xs"
          @click="toggleAllRevealed"
        >
          <EyeOff
            v-if="allRevealed"
            class="size-3.5"
          />
          <Eye
            v-else
            class="size-3.5"
          />
          {{ allRevealed ? "Hide secrets" : "Show secrets" }}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          class="h-7 px-2 text-xs"
          @click="choose(allIds, 'local')"
        >
          All local
        </Button>
        <Button
          size="sm"
          variant="ghost"
          class="h-7 px-2 text-xs"
          @click="choose(allIds, 'remote')"
        >
          All {{ remoteName }}
        </Button>
      </div>
    </div>

    <div
      v-if="entries.length > 0"
      class="overflow-hidden rounded-md border"
    >
      <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
        <span>Key</span>
        <span>Local</span>
        <span class="truncate">{{ remoteName }}</span>
      </div>
      <div
        v-for="row in rows"
        :key="row.id"
        class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 border-b px-3 py-1.5 text-xs last:border-b-0"
      >
        <template v-if="row.kind === 'branch'">
          <span
            class="truncate font-mono font-medium"
            :style="{ paddingLeft: indentOf(row.depth) }"
            :title="row.name"
          >{{ row.name }}</span>
          <button
            type="button"
            :class="cn('min-w-0 truncate rounded px-2 py-0.5 text-left transition-colors', branchSide(row) === 'local' ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-accent')"
            :title="branchSide(row) === 'mixed' ? 'Mixed' : branchSide(row) === 'local' ? 'All local' : 'Take local'"
            @click="choose(row.leaves, 'local')"
          >
            {{ branchSide(row) === "mixed" ? "Mixed" : branchSide(row) === "local" ? "All local" : "Take local" }}
          </button>
          <button
            type="button"
            :class="cn('min-w-0 truncate rounded px-2 py-0.5 text-left transition-colors', branchSide(row) === 'remote' ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-accent')"
            :title="branchSide(row) === 'mixed' ? 'Mixed' : branchSide(row) === 'remote' ? `All ${remoteName}` : `Take ${remoteName}`"
            @click="choose(row.leaves, 'remote')"
          >
            {{ branchSide(row) === "mixed" ? "Mixed" : branchSide(row) === "remote" ? `All ${remoteName}` : `Take ${remoteName}` }}
          </button>
        </template>

        <template v-else>
          <div
            class="flex min-w-0 items-center gap-1.5"
            :style="{ paddingLeft: indentOf(row.depth) }"
          >
            <span
              class="truncate font-mono"
              :title="row.name"
            >{{ row.name }}</span>
            <Badge
              variant="outline"
              class="max-w-1/2 min-w-0 shrink px-1.5 py-0 text-[10px]"
              :title="differenceLabel(row.entry)"
            >
              <span class="truncate">{{ differenceLabel(row.entry) }}</span>
            </Badge>
            <button
              v-if="isSensitive(row)"
              type="button"
              class="shrink-0 text-muted-foreground hover:text-foreground"
              :title="revealed[row.id] ? 'Hide the values' : 'Show the values'"
              @click="revealed = { ...revealed, [row.id]: !revealed[row.id] }"
            >
              <EyeOff
                v-if="revealed[row.id]"
                class="size-3.5"
              />
              <Eye
                v-else
                class="size-3.5"
              />
            </button>
          </div>
          <button
            v-for="side in (['local', 'remote'] as const)"
            :key="side"
            type="button"
            :class="cn(
              'min-w-0 truncate rounded border px-2 py-0.5 text-left font-mono transition-colors',
              sideOf(row.id) === side ? 'border-primary bg-primary/15 text-foreground' : 'border-transparent text-muted-foreground hover:bg-accent',
              !row.entry[side].present && 'italic',
            )"
            :title="isSensitive(row) && !revealed[row.id] ? undefined : formatValue(row.entry[side]).full"
            @click="choose([row.id], side)"
          >
            {{ isSensitive(row) && !revealed[row.id] && row.entry[side].present ? "••••••" : formatValue(row.entry[side]).short }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
