<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  CircleDashed,
  Database,
  FileBadge,
  FileText,
  KeyRound,
  Loader2,
  Lock,
  MemoryStick,
  Package,
  Pencil,
  RefreshCw,
  RotateCcw,
  SkipForward,
  Trash2,
  TriangleAlert,
  UserRound,
  X
} from '@lucide/vue'
import type { EnvironmentAction, EnvironmentCopyPayload, EnvironmentItemPayload, EnvironmentKeyChoicePayload, EnvironmentStepPayload } from '@appsys-sas/devtool-shared'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ConfigKeyChooser from '@/components/ConfigKeyChooser.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { expiryClass, expiryLabel } from '@/lib/expiry'
import { formatBytes, formatProgress, formatRelativeDate, progressPercent } from '@/lib/format'
import { cn } from '@/lib/utils'
import environmentStore from '@/stores/environment'
import sessionStore from '@/stores/session'
import wsStore from '@/stores/ws'

interface SyncStatus {
  label: string
  tone: 'remote' | 'local' | 'conflict' | 'muted' | 'synced'
}

type Side = EnvironmentKeyChoicePayload['side']

interface ItemSelection {
  tables: string[] | null
  keys: Record<string, Side> | null
}

const SAME_DATE_TOLERANCE_MS = 1000
const ACTION_LABELS: Record<EnvironmentAction, string> = { pull: 'Pull', push: 'Push', restore: 'Restore', remove: 'Removal of local copies' }
const TONE_CLASSES: Record<SyncStatus['tone'], string> = {
  remote: 'border-sky-500/40 text-sky-600 dark:text-sky-400',
  local: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  conflict: 'border-destructive/40 text-destructive',
  muted: 'text-muted-foreground',
  synced: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
}

const state = environmentStore.state
const session = sessionStore.state
const selected = ref<Record<string, ItemSelection>>({})
const tableFilters = ref<Record<string, string>>({})
const pendingAction = ref<EnvironmentAction | null>(null)
const confirmOpen = ref(false)
const pullingConfig = ref(false)

const running = computed(() => state.value?.run?.finished === false)
const signInNeeded = computed(() => session.value?.configured === true && !session.value.signedIn && (state.value?.backends ?? []).some(backend => backend.type === 'cdn'))
const defaultBackend = computed(() => state.value?.backends.find(backend => backend.default) ?? null)

watch(running, isRunning => {
  if (isRunning) {
    return
  }

  for (const [path, selection] of Object.entries(selected.value)) {
    if (selection.keys !== null) {
      chooseWholeFile(path, false)
    }
  }
})

const groups = computed(() => {
  const bySection = new Map<string, EnvironmentItemPayload[]>()
  for (const item of state.value?.items ?? []) {
    bySection.set(item.section, [...(bySection.get(item.section) ?? []), item])
  }

  return [...bySection.entries()].map(([section, items]) => ({ section, items }))
})

const targets = computed(() =>
  Object.entries(selected.value).map(([path, { tables, keys }]) => {
    const entries = keys ? environmentStore.keys.value[path]?.entries : undefined
    const item = state.value?.items.find(candidate => candidate.path === path)
    return {
      path,
      tables,
      keys: entries && keys ? entries.map(entry => ({ path: entry.path, side: keys[JSON.stringify(entry.path)] ?? (item ? defaultSideOf(item) : 'remote') })) : null
    }
  })
)
const incomplete = computed(() =>
  Object.entries(selected.value).some(
    ([path, { tables, keys }]) => (tables !== null && tables.length === 0) || (keys !== null && (!environmentStore.keys.value[path] || environmentStore.keys.value[path].error !== null))
  )
)
const canRun = computed(() => !running.value && targets.value.length > 0 && !incomplete.value)

const overwritten = computed(() =>
  targets.value
    .map(target => ({ target, item: state.value?.items.find(item => item.path === target.path) }))
    .filter(({ item }) => item && item.kind !== 'file')
    .map(({ target, item }) => {
      if (item?.kind === 'bucket') {
        return `${item.path}: bucket ${item.bucket} replaced by its snapshot`
      }

      if (item?.kind === 'redis') {
        return target.tables
          ? `${target.path}: key groups ${target.tables.join(', ')} emptied and reloaded`
          : `${item.path}: Redis database ${item.redis} emptied and reloaded`
      }

      return target.tables
        ? `${target.path}: tables ${target.tables.join(', ')} emptied and reloaded`
        : `${target.path}: database ${item?.database ? `${item.database} ` : ''}of container ${item?.container} dropped and recreated`
    })
)
const selectedItems = computed(() => (state.value?.items ?? []).filter(item => selected.value[item.path]))
const confirmation = computed(() => {
  switch (pendingAction.value) {
    case 'pull':
      return { title: 'Replace local data?', confirm: 'Pull and replace', intro: 'The backend copies will replace your local data:', lines: overwritten.value }
    case 'restore':
      return { title: 'Restore local data?', confirm: 'Restore', intro: 'The local copies will replace your local data:', lines: overwritten.value }
    case 'remove':
      return {
        title: 'Remove local copies?',
        confirm: 'Remove',
        intro: 'These local copies are deleted; the data they restored stays as it is:',
        lines: selectedItems.value.map(item => `${item.path} (${item.local ? formatBytes(item.local.size) : 'none'})`)
      }
    default:
      return null
  }
})

/**
 * Tells whether an action can be run. A pull or a push needs the groups of the developer to let them
 * transfer every selected item, those restricted to some tables or key groups allowing it, or at
 * least one item while none is selected. A restore or a removal needs selected items whose local
 * data lives apart from their local copy, a restore of some tables needing them to allow it.
 * @param action The action.
 * @returns True when the action is shown.
 */
function shows (action: EnvironmentAction): boolean {
  if (action === 'restore' || action === 'remove') {
    return selectedItems.value.length > 0 && selectedItems.value.every(item =>
      item.kind !== 'file' && item.local !== null && (action === 'remove' || selected.value[item.path].tables === null || item.parts.pull))
  }
  return selectedItems.value.length > 0
    ? selectedItems.value.every(item => item.allowed[action] && (selected.value[item.path].tables === null || item.parts[action]))
    : (state.value?.items ?? []).some(item => item.allowed[action])
}

/**
 * Runs an action over the selected items, after confirmation when it replaces or removes local data.
 * @param action The action.
 */
function start (action: EnvironmentAction): void {
  if (action === 'push' || (action === 'pull' && overwritten.value.length === 0)) {
    wsStore.envRun(action, targets.value)
    return
  }
  pendingAction.value = action
  confirmOpen.value = true
}

/**
 * Runs the action waiting for confirmation over the selected items.
 */
function confirm (): void {
  if (pendingAction.value) {
    wsStore.envRun(pendingAction.value, targets.value)
  }
}

/**
 * Tells whether a step of the pull in progress can still be cancelled: it waits, or its archive is
 * not fully downloaded yet.
 * @param step The step.
 * @returns True when its cancel button is shown.
 */
function cancellable (step: EnvironmentStepPayload): boolean {
  if (state.value?.run?.action !== 'pull' || state.value.run.finished) {
    return false
  }
  return step.status === 'pending' || (step.status === 'running' && !(step.progress?.total != null && step.progress.done >= step.progress.total))
}

/**
 * Names the backend storing an item.
 * @param item The item.
 * @returns The name of its backend, "backend" when the environment declares none.
 */
function backendOf (item: EnvironmentItemPayload): string {
  return item.backend ?? 'backend'
}

/**
 * Tells whether two dates differ by more than the precision of the stores.
 * @param date The first date, in ISO format.
 * @param other The second date, in ISO format.
 * @returns True when they differ.
 */
function differs (date: string, other: string): boolean {
  return Math.abs(new Date(date).getTime() - new Date(other).getTime()) > SAME_DATE_TOLERANCE_MS
}

/**
 * Compares the local copy of an item with its copy on its backend. An item whose local data lives
 * apart from its local copy stays synchronized once that copy is removed, as long as the copy of its
 * backend does not change.
 * @param item The item.
 * @returns The status to show, or null when the copies of its backend are unknown.
 */
function syncStatus (item: EnvironmentItemPayload): SyncStatus | null {
  if (item.remote === 'unknown') {
    return null
  }

  if (!item.remote) {
    return item.local ? { label: 'Only local', tone: 'local' } : { label: 'Missing', tone: 'muted' }
  }

  if (!item.local) {
    if (item.kind === 'file' || !item.synced) {
      return { label: `Only on ${backendOf(item)}`, tone: 'remote' }
    }
    return differs(item.remote.updatedAt, item.synced.remoteUpdatedAt) ? { label: `Newer on ${backendOf(item)}`, tone: 'remote' } : { label: 'Up to date', tone: 'synced' }
  }

  if (item.synced) {
    const localChanged = differs(item.local.updatedAt, item.synced.localUpdatedAt)
    const remoteChanged = differs(item.remote.updatedAt, item.synced.remoteUpdatedAt)
    if (localChanged && remoteChanged) {
      return { label: 'Changed on both', tone: 'conflict' }
    }

    if (localChanged || remoteChanged) {
      return localChanged ? { label: 'Newer locally', tone: 'local' } : { label: `Newer on ${backendOf(item)}`, tone: 'remote' }
    }

    return { label: 'Up to date', tone: 'synced' }
  }

  const difference = new Date(item.remote.updatedAt).getTime() - new Date(item.local.updatedAt).getTime()
  if (Math.abs(difference) <= SAME_DATE_TOLERANCE_MS) {
    return { label: 'Up to date', tone: 'synced' }
  }

  return difference > 0 ? { label: `Newer on ${backendOf(item)}`, tone: 'remote' } : { label: 'Newer locally', tone: 'local' }
}

/**
 * Describes what an item holds.
 * @param item The item.
 * @returns A short description.
 */
function describeItem (item: EnvironmentItemPayload): string {
  switch (item.kind) {
    case 'database':
      return `${item.engine} · container ${item.container}${item.database ? ` · ${item.database}` : ''}`
    case 'bucket':
      return `bucket ${item.bucket}`
    case 'redis':
      return `redis · ${item.redis}`
    default:
      if (item.pem?.kind === 'certificate') {
        return 'certificate'
      }
      return item.pem?.kind === 'privateKey' ? 'private key' : 'file'
  }
}

/**
 * Tells how many of some items are selected, for a checkbox standing for all of them.
 * @param items The items.
 * @returns True when all are, "indeterminate" when some are, false when none is.
 */
function selectionState (items: EnvironmentItemPayload[]): boolean | 'indeterminate' {
  const count = items.filter(item => selected.value[item.path]).length
  return count === 0 ? false : count === items.length || 'indeterminate'
}

/**
 * Selects or unselects some items, keeping the choices of those already selected.
 * @param items The items.
 * @param checked Whether they are selected.
 */
function selectAll (items: EnvironmentItemPayload[], checked: boolean): void {
  const next = { ...selected.value }
  for (const item of items) {
    if (!checked) {
      delete next[item.path]
    } else {
      next[item.path] ??= { tables: null, keys: null }
    }
  }
  selected.value = next
}

/**
 * Names the parts of a database item that can be transferred on their own.
 * @param item The database or Redis item.
 * @returns "key groups" for a Redis database, "tables" otherwise.
 */
function partsOf (item: EnvironmentItemPayload): string {
  return item.kind === 'redis' ? 'key groups' : 'tables'
}

/**
 * Chooses between the whole database and some of its tables or key groups.
 * @param path The path of the database or Redis item.
 * @param whole Whether the whole database is transferred.
 */
function chooseWhole (path: string, whole: boolean): void {
  selected.value = { ...selected.value, [path]: { tables: whole ? null : [], keys: null } }
  if (!whole && !environmentStore.tables.value[path]) {
    wsStore.envTables(path)
  }
}

/**
 * Tells whether the keys of an item can be chosen one by one: a configuration file present on both sides.
 * @param item The item.
 * @returns True for such a file.
 */
function hasKeys (item: EnvironmentItemPayload): boolean {
  return item.keyed && item.local !== null && item.remote !== null && item.remote !== 'unknown'
}

/**
 * Gives the copy a differing key takes until the developer chooses: the newer one.
 * @param item The configuration file item.
 * @returns The backend when its copy is newer, the local copy otherwise.
 */
function defaultSideOf (item: EnvironmentItemPayload): Side {
  return syncStatus(item)?.tone === 'local' ? 'local' : 'remote'
}

/**
 * Chooses between the whole file and some of its keys, asking the server for the differing keys.
 * @param path The path of the configuration file item.
 * @param whole Whether the whole file is transferred.
 */
function chooseWholeFile (path: string, whole: boolean): void {
  selected.value = { ...selected.value, [path]: { tables: null, keys: whole ? null : {} } }
  if (!whole) {
    environmentStore.forgetKeys(path)
    wsStore.envKeys(path)
  }
}

/**
 * Keeps the copies chosen for the differing keys of a configuration file.
 * @param path The path of the configuration file item.
 * @param keys The copy of each key.
 */
function setKeys (path: string, keys: Record<string, Side>): void {
  selected.value = { ...selected.value, [path]: { tables: null, keys } }
}

/**
 * Selects or unselects a table of a database.
 * @param path The path of the database item.
 * @param table The table.
 */
function toggleTable (path: string, table: string): void {
  const tables = selected.value[path]?.tables ?? []
  const next = tables.includes(table) ? tables.filter(candidate => candidate !== table) : [...tables, table]
  selected.value = { ...selected.value, [path]: { tables: next, keys: null } }
}

/**
 * Lists the tables of a database matching its filter.
 * @param path The path of the database item.
 * @returns The tables.
 */
function visibleTables (path: string): string[] {
  const filter = (tableFilters.value[path] ?? '').toLowerCase()
  return (environmentStore.tables.value[path]?.tables ?? []).filter(table => table.toLowerCase().includes(filter))
}

/**
 * Selects the items whose backend copy is newer than the local one, or only on their backend.
 */
function selectNewerRemotely (): void {
  selected.value = Object.fromEntries(
    (state.value?.items ?? []).filter(item => syncStatus(item)?.tone === 'remote').map(item => [item.path, { tables: null, keys: null }])
  )
}

/**
 * Starts a sign-in, in a new tab.
 */
function login (): void {
  sessionStore.openLoginWindow()
  wsStore.authLogin()
}

/**
 * Names the date and size of a copy.
 * @param copy The copy.
 * @returns Its relative date and size.
 */
function copyLabel (copy: EnvironmentCopyPayload): string {
  return `${formatRelativeDate(copy.updatedAt)} · ${formatBytes(copy.size)}`
}

/**
 * Gives the icon of a progress step.
 * @param step The step.
 * @returns The icon component and its classes.
 */
function stepIcon (step: EnvironmentStepPayload): { icon: unknown, class: string } {
  switch (step.status) {
    case 'running':
      return { icon: Loader2, class: 'animate-spin text-sky-500' }
    case 'done':
      return { icon: Check, class: 'text-emerald-500' }
    case 'skipped':
      return { icon: SkipForward, class: 'text-amber-500' }
    case 'failed':
      return { icon: X, class: 'text-destructive' }
    default:
      return { icon: CircleDashed, class: 'text-muted-foreground' }
  }
}

/**
 * Downloads the shared devtool configuration, which declares the environment.
 */
function pullConfig (): void {
  pullingConfig.value = true
  wsStore.envPullConfig()
}

watch(state, () => {
  pullingConfig.value = false
})

onMounted(() => wsStore.envRefresh())
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="min-h-0 flex-1 overflow-auto p-6">
      <div class="mx-auto max-w-5xl space-y-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 class="text-xl font-semibold">
              Environment
            </h1>
            <p class="text-sm text-muted-foreground">
              Configurations, databases, buckets and Redis databases shared by the developers: <code>environment.folder</code> ⇄
              <template v-if="state?.backends.length">
                <template
                  v-for="(backend, index) in state.backends"
                  :key="backend.name"
                >
                  {{ index > 0 ? ", " : "" }}<span class="font-medium text-foreground">{{ backend.name }}</span>
                  <span class="text-xs">({{ backend.type }}{{ backend.encrypted ? ", encrypted" : "" }})</span>
                </template>
              </template>
              <template v-else>
                backends.
              </template>
            </p>
          </div>
          <div class="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              :disabled="running || !state?.items.length"
              @click="selectNewerRemotely"
            >
              Select newer remotely
            </Button>
            <Button
              size="sm"
              variant="outline"
              class="gap-1.5"
              :disabled="running"
              @click="wsStore.envRefresh()"
            >
              <RefreshCw class="size-3.5" />
              Refresh
            </Button>
          </div>
        </div>

        <div
          v-if="signInNeeded && session"
          class="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 p-3"
        >
          <div class="flex items-center gap-2 text-sm">
            <UserRound class="size-4 text-muted-foreground" />
            Not signed in: the copies of the cdn backends are unknown and cannot be transferred.
          </div>
          <Button
            v-if="!session.pendingLoginUrl"
            size="sm"
            @click="login"
          >
            Sign in{{ session.providerName ? ` with ${session.providerName}` : "" }}
          </Button>
          <span
            v-else
            class="text-xs text-muted-foreground"
          >Waiting for {{ session.providerName ?? "the sign-in" }}…</span>
        </div>

        <div
          v-if="state?.error"
          class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive"
        >
          <TriangleAlert class="mt-0.5 size-4 shrink-0" />
          <span>{{ state.error }}</span>
        </div>

        <Card
          v-if="!state?.configured"
          class="items-center gap-4 py-10 text-center"
        >
          <div class="space-y-1">
            <p class="font-medium">
              No environment yet
            </p>
            <p class="text-sm text-muted-foreground">
              Declare a backend in <code>environment.backends</code> of <code>config.local.yml</code> of the configuration folder to get the shared devtool configuration.
            </p>
          </div>
        </Card>

        <Card
          v-else-if="!state.items.length"
          class="items-center gap-4 py-10 text-center"
        >
          <div class="space-y-1">
            <p class="font-medium">
              No items yet
            </p>
            <p class="text-sm text-muted-foreground">
              The shared devtool configuration declares them: pull it from <span class="font-medium text-foreground">{{ defaultBackend?.name ?? "the default backend" }}</span> to list the configurations, databases, buckets and Redis databases.
            </p>
          </div>
          <Button
            class="gap-1.5"
            :disabled="pullingConfig"
            @click="pullConfig"
          >
            <Loader2
              v-if="pullingConfig"
              class="size-4 animate-spin"
            />
            <ArrowDownToLine
              v-else
              class="size-4"
            />
            Pull the devtool configuration
          </Button>
        </Card>

        <Card
          v-for="group in groups"
          :key="group.section"
          class="gap-0 overflow-hidden py-0"
        >
          <div class="flex items-center justify-between border-b bg-muted/40 px-4 py-2">
            <label class="flex items-center gap-3">
              <Checkbox
                :model-value="selectionState(group.items)"
                :disabled="running"
                @update:model-value="(checked) => selectAll(group.items, checked === true)"
              />
              <span class="text-xs font-semibold tracking-wide text-muted-foreground">{{ group.section }}</span>
            </label>
            <span class="text-xs text-muted-foreground">{{ group.items.length }} {{ group.items.length > 1 ? "items" : "item" }}</span>
          </div>

          <div
            v-for="item in group.items"
            :key="item.path"
            class="border-b last:border-b-0"
          >
            <div
              :class="cn(
                'grid cursor-pointer grid-cols-[auto_auto_minmax(0,1fr)_9rem_9rem_8rem] items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40',
                selected[item.path] && 'bg-accent/30',
                running && 'pointer-events-none opacity-70',
              )"
              @click="selectAll([item], !selected[item.path])"
            >
              <Checkbox
                :model-value="Boolean(selected[item.path])"
                @click.stop
                @update:model-value="(checked) => selectAll([item], checked === true)"
              />
              <div class="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Database
                  v-if="item.kind === 'database'"
                  class="size-4"
                />
                <Package
                  v-else-if="item.kind === 'bucket'"
                  class="size-4"
                />
                <MemoryStick
                  v-else-if="item.kind === 'redis'"
                  class="size-4"
                />
                <FileBadge
                  v-else-if="item.pem?.kind === 'certificate'"
                  class="size-4"
                />
                <KeyRound
                  v-else-if="item.pem?.kind === 'privateKey'"
                  class="size-4"
                />
                <FileText
                  v-else
                  class="size-4"
                />
              </div>
              <div class="min-w-0">
                <div class="flex items-center gap-1.5">
                  <span class="truncate font-mono text-sm">{{ item.path }}</span>
                  <RouterLink
                    v-if="item.kind === 'file'"
                    :to="{ name: 'configs', query: { path: item.path } }"
                    title="Edit the local copy"
                    class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    @click.stop
                  >
                    <Pencil class="size-3.5" />
                  </RouterLink>
                </div>
                <div class="truncate text-xs text-muted-foreground">
                  {{ describeItem(item) }}
                  <template v-if="item.pem?.kind === 'certificate'">
                    · <span :class="expiryClass(item.pem.expiresAt)">{{ expiryLabel(item.pem.expiresAt) }}</span>
                  </template>
                </div>
              </div>
              <div class="min-w-0 text-xs">
                <div class="text-muted-foreground">
                  Local
                </div>
                <div class="truncate">
                  {{ item.local ? copyLabel(item.local) : "—" }}
                </div>
              </div>
              <div class="min-w-0 text-xs">
                <div class="flex items-center gap-1 text-muted-foreground">
                  <span class="truncate">{{ backendOf(item) }}</span>
                  <span
                    v-if="item.encrypted"
                    title="Encrypted before it is sent"
                    class="shrink-0"
                  >
                    <Lock
                      class="size-3"
                      aria-label="Encrypted"
                    />
                  </span>
                </div>
                <div class="truncate">
                  {{ item.remote === "unknown" ? "Unknown" : item.remote ? copyLabel(item.remote) : "—" }}
                </div>
              </div>
              <div class="flex justify-end">
                <Badge
                  v-if="syncStatus(item)"
                  variant="outline"
                  :class="TONE_CLASSES[syncStatus(item)!.tone]"
                >
                  {{ syncStatus(item)!.label }}
                </Badge>
              </div>
            </div>

            <div
              v-if="hasKeys(item) && selected[item.path]"
              class="space-y-3 px-4 pb-4 pl-[4.25rem]"
            >
              <div class="inline-flex rounded-md border p-0.5 text-xs">
                <button
                  type="button"
                  :class="cn('rounded px-2.5 py-1 transition-colors', selected[item.path].keys === null ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')"
                  @click="chooseWholeFile(item.path, true)"
                >
                  Whole file
                </button>
                <button
                  type="button"
                  :class="cn('rounded px-2.5 py-1 transition-colors', selected[item.path].keys !== null ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')"
                  @click="chooseWholeFile(item.path, false)"
                >
                  Some keys
                </button>
              </div>

              <template v-if="selected[item.path].keys !== null">
                <div
                  v-if="!environmentStore.keys.value[item.path]"
                  class="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <Loader2 class="size-3.5 animate-spin" />
                  Comparing the local and {{ backendOf(item) }} copies…
                </div>
                <div
                  v-else-if="environmentStore.keys.value[item.path].error"
                  class="text-xs text-destructive"
                >
                  {{ environmentStore.keys.value[item.path].error }}
                </div>
                <ConfigKeyChooser
                  v-else
                  :model-value="selected[item.path].keys!"
                  :entries="environmentStore.keys.value[item.path].entries"
                  :default-side="defaultSideOf(item)"
                  :remote-name="backendOf(item)"
                  @update:model-value="(keys) => setKeys(item.path, keys)"
                />
              </template>
            </div>

            <div
              v-if="(item.parts.pull || item.parts.push) && selected[item.path]"
              class="space-y-3 px-4 pb-4 pl-[4.25rem]"
            >
              <div class="inline-flex rounded-md border p-0.5 text-xs">
                <button
                  type="button"
                  :class="cn('rounded px-2.5 py-1 transition-colors', selected[item.path].tables === null ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')"
                  @click="chooseWhole(item.path, true)"
                >
                  Whole database
                </button>
                <button
                  type="button"
                  :class="cn('rounded px-2.5 py-1 transition-colors', selected[item.path].tables !== null ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')"
                  @click="chooseWhole(item.path, false)"
                >
                  Some {{ partsOf(item) }}
                </button>
              </div>

              <div
                v-if="selected[item.path].tables !== null"
                class="space-y-2"
              >
                <div
                  v-if="!environmentStore.tables.value[item.path]"
                  class="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <Loader2 class="size-3.5 animate-spin" />
                  Loading the {{ partsOf(item) }} of {{ item.container ?? item.redis }}…
                </div>
                <div
                  v-else-if="environmentStore.tables.value[item.path].error"
                  class="text-xs text-destructive"
                >
                  {{ environmentStore.tables.value[item.path].error }}
                </div>
                <template v-else>
                  <div class="flex items-center gap-2">
                    <Input
                      v-model="tableFilters[item.path]"
                      :placeholder="`Filter ${partsOf(item)}`"
                      class="h-8 max-w-64 text-xs"
                    />
                    <span class="text-xs text-muted-foreground">
                      {{ selected[item.path].tables!.length }} of {{ environmentStore.tables.value[item.path].tables.length }} selected
                    </span>
                  </div>
                  <div class="flex max-h-40 flex-wrap gap-1.5 overflow-auto">
                    <button
                      v-for="table in visibleTables(item.path)"
                      :key="table"
                      type="button"
                      :class="cn(
                        'rounded-full border px-2.5 py-0.5 font-mono text-xs transition-colors',
                        selected[item.path].tables!.includes(table) ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent',
                      )"
                      @click="toggleTable(item.path, table)"
                    >
                      {{ table }}
                    </button>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>

    <div
      v-if="state?.run"
      class="flex max-h-64 shrink-0 flex-col gap-2 border-t bg-card px-6 py-3"
    >
      <div class="mx-auto flex w-full max-w-5xl shrink-0 items-center justify-between gap-2">
        <span class="text-sm font-medium">
          {{ ACTION_LABELS[state.run.action] }} {{ state.run.finished ? "finished" : "in progress" }}
        </span>
        <div class="flex items-center gap-2">
          <span class="text-xs text-muted-foreground">
            {{ state.run.steps.filter((step) => step.status === "done").length }} / {{ state.run.steps.length }} done
          </span>
          <Button
            v-if="state.run.finished"
            size="icon"
            variant="ghost"
            class="size-6"
            title="Close"
            @click="wsStore.envDismissRun()"
          >
            <X class="size-4" />
          </Button>
        </div>
      </div>
      <div class="mx-auto min-h-0 w-full max-w-5xl space-y-2 overflow-auto">
        <div
          v-for="(step, index) in state.run.steps"
          :key="step.target"
          class="flex items-start gap-2 text-sm"
        >
          <component
            :is="stepIcon(step).icon"
            :class="cn('mt-0.5 size-4 shrink-0', stepIcon(step).class)"
          />
          <span
            class="min-w-0 truncate font-mono text-xs leading-5"
            :title="step.target"
          >{{ step.target }}</span>
          <span
            v-if="step.progress"
            class="ml-auto flex shrink-0 items-center gap-2 text-xs leading-5 text-muted-foreground tabular-nums"
          >
            <span
              v-if="progressPercent(step.progress.done, step.progress.total) !== null"
              class="h-1.5 w-24 overflow-hidden rounded-full bg-muted"
            >
              <span
                class="block h-full rounded-full bg-sky-500 transition-[width]"
                :style="{ width: `${progressPercent(step.progress.done, step.progress.total)}%` }"
              />
            </span>
            {{ formatProgress(step.progress.done, step.progress.total) }}
          </span>
          <span
            v-if="step.detail"
            :class="cn('min-w-0 truncate text-xs leading-5', step.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')"
            :title="step.detail"
          >{{ step.detail }}</span>
          <Button
            v-if="cancellable(step)"
            size="icon"
            variant="ghost"
            :class="cn('size-5 shrink-0', !step.progress && 'ml-auto')"
            title="Cancel the download of this item"
            @click="wsStore.envCancel(index)"
          >
            <X class="size-3.5" />
          </Button>
        </div>
      </div>
    </div>

    <div class="shrink-0 border-t bg-background px-6 py-3">
      <div class="mx-auto flex max-w-5xl items-center justify-between gap-3">
        <div class="flex items-center gap-3 text-sm text-muted-foreground">
          <Checkbox
            aria-label="Select all items"
            :model-value="selectionState(state?.items ?? [])"
            :disabled="running || !state?.items.length"
            @update:model-value="(checked) => selectAll(state?.items ?? [], checked === true)"
          />
          <span v-if="targets.length === 0">Select items to transfer.</span>
          <span v-else-if="incomplete">Choose at least one table or key group for each database restricted to some.</span>
          <span v-else>{{ targets.length }} {{ targets.length > 1 ? "items" : "item" }} selected</span>
        </div>
        <div
          v-if="state?.run?.action === 'pull' && running"
          class="flex items-center gap-2"
        >
          <Button
            variant="outline"
            class="gap-1.5"
            @click="wsStore.envCancel(null)"
          >
            <X class="size-4" />
            Cancel pull
          </Button>
        </div>
        <div
          v-else
          class="flex items-center gap-2"
        >
          <Button
            v-if="shows('remove')"
            variant="ghost"
            class="gap-1.5"
            :disabled="!canRun"
            @click="start('remove')"
          >
            <Trash2 class="size-4" />
            Remove local copy
          </Button>
          <Button
            v-if="shows('restore')"
            variant="outline"
            class="gap-1.5"
            :disabled="!canRun"
            @click="start('restore')"
          >
            <RotateCcw class="size-4" />
            Restore
          </Button>
          <Button
            v-if="shows('push')"
            variant="outline"
            class="gap-1.5"
            :disabled="!canRun"
            @click="start('push')"
          >
            <ArrowUpFromLine class="size-4" />
            Push
          </Button>
          <Button
            v-if="shows('pull')"
            class="gap-1.5"
            :disabled="!canRun"
            @click="start('pull')"
          >
            <ArrowDownToLine class="size-4" />
            Pull
          </Button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      v-model:open="confirmOpen"
      :title="confirmation?.title ?? ''"
      :confirm-label="confirmation?.confirm ?? ''"
      @confirm="confirm"
    >
      <p>{{ confirmation?.intro }}</p>
      <ul class="mt-2 list-disc space-y-1 pl-5">
        <li
          v-for="line in confirmation?.lines ?? []"
          :key="line"
        >
          {{ line }}
        </li>
      </ul>
    </ConfirmDialog>
  </div>
</template>
