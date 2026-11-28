<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
import type { EnvironmentAction, EnvironmentCopyPayload, EnvironmentItemPayload, EnvironmentKeyChoicePayload, EnvironmentRunPayload, EnvironmentStepPayload } from '@appsys-sas/devtool-shared'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ConfigKeyChooser from '@/components/ConfigKeyChooser.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { expiryClass, expiryLabel } from '@/lib/expiry'
import { formatBytes, formatProgress, formatRelativeDate, progressPercent } from '@/lib/format'
import { differs, remoteChangedSince, SAME_DATE_TOLERANCE_MS } from '@/lib/sync-changes'
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

interface TransferSpeed {
  bytesPerSecond: number
  movedAt: number
}

/** What an item restricted to some of its parts is restricted to: tables or key groups, or keys. */
type ChoiceKind = 'tables' | 'keys'

const STALE_SPEED_MS = 2000
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
let confirmedTargets = ''
let confirmedRevision = 0
const tableFilters = ref<Record<string, string>>({})
const pendingAction = ref<EnvironmentAction | null>(null)
const confirmOpen = ref(false)
const pullingConfig = ref(false)

const running = computed(() => state.value?.run?.finished === false)
const speeds = ref<Record<string, TransferSpeed>>({})
const samples = new Map<string, { done: number, at: number }>()
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined

watch(() => state.value?.run?.steps, () => {
  measureSpeeds(state.value?.run ?? null)
})
watch(running, isRunning => {
  clearInterval(clock)
  clock = isRunning
    ? setInterval(() => {
        now.value = Date.now()
      }, 1000)
    : undefined
}, { immediate: true })
onBeforeUnmount(() => clearInterval(clock))
watch(() => state.value?.items, items => {
  if (items) {
    reconcileSelection(items)
  }
})
watch(() => state.value?.refreshing, (refreshing, before) => {
  if (before && !refreshing) {
    describedAgain()
  }
})
watch(() => environmentStore.tables.value, () => settleAnswers('tables'))
watch(() => environmentStore.keys.value, () => settleAnswers('keys'))
watch(() => (confirmOpen.value && pendingAction.value ? JSON.stringify(targetsOf(pendingAction.value)) : null), shown => {
  if (shown !== null && shown !== confirmedTargets) {
    confirmOpen.value = false
  }
})
const signInNeeded = computed(() => session.value?.configured === true && !session.value.signedIn && (state.value?.backends ?? []).some(backend => backend.type === 'cdn'))
const defaultBackend = computed(() => state.value?.backends.find(backend => backend.default) ?? null)

const groups = computed(() => {
  const bySection = new Map<string, EnvironmentItemPayload[]>()
  for (const item of state.value?.items ?? []) {
    bySection.set(item.section, [...(bySection.get(item.section) ?? []), item])
  }

  return [...bySection.entries()].map(([section, items]) => ({ section, items }))
})

const targets = computed(() =>
  Object.entries(selected.value).map(([path, { tables, keys }]) => {
    const item = state.value?.items.find(candidate => candidate.path === path)
    const entries = keys ? environmentStore.keys.value[path]?.entries : undefined
    return {
      path,
      tables,
      keys: entries && keys ? entries.map(entry => ({ path: entry.path, side: keys[JSON.stringify(entry.path)] ?? (item ? defaultSideOf(item) : 'remote') })) : null
    }
  })
)
const selectionHint = computed(() => {
  const count = `${targets.value.length} ${targets.value.length > 1 ? 'items' : 'item'} selected`
  if (targets.value.length === 0) {
    return 'Select items to transfer.'
  }
  if (running.value) {
    return count
  }
  for (const { path } of targets.value) {
    const selection = selected.value[path]
    const tables = environmentStore.tables.value[path]
    if (selection.tables !== null && !tables) {
      return 'Listing the tables of the databases restricted to some…'
    }
    if (selection.tables !== null && tables?.error) {
      return `The tables of ${path} could not be listed: transfer it whole.`
    }
    if (selection.tables?.length === 0) {
      return 'Choose at least one table or key group for each database restricted to some.'
    }
    const keys = environmentStore.keys.value[path]
    if (selection.keys !== null && !keys) {
      return 'Comparing the keys of the files restricted to some keys…'
    }
    if (selection.keys !== null && keys?.error) {
      return `The keys of ${path} could not be compared: send it whole.`
    }
  }
  return count
})

const selectedItems = computed(() => (state.value?.items ?? []).filter(item => selected.value[item.path]))
const confirmation = computed(() => {
  switch (pendingAction.value) {
    case 'pull':
      return { title: 'Replace local data?', confirm: 'Pull and replace', intro: 'The backend copies will replace your local data:', lines: targets.value.flatMap(target => replacementOf(target) ?? []) }
    case 'restore':
      return { title: 'Restore local data?', confirm: 'Restore', intro: 'The local copies will replace your local data:', lines: targetsOf('restore').flatMap(target => replacementOf(target) ?? []) }
    case 'remove':
      return {
        title: 'Remove local copies?',
        confirm: 'Remove',
        intro: 'These local copies are deleted; the data they restored stays as it is:',
        lines: targetsOf('remove').map(target => `${target.path} (${sizeLabel(itemAt(target.path)?.local?.size ?? null)})`)
      }
    default:
      return null
  }
})

/**
 * Names a step of a run, unique across runs and among steps of the same item.
 * @param runId The run.
 * @param index The step.
 * @returns The key of the step.
 */
function stepKey (runId: string, index: number): string {
  return `${runId}/${index}`
}

/**
 * Measures the speed of each transfer of the run from the progress the server publishes, averaged
 * with the previous measure; a report that moved nothing keeps the last speed and when it moved.
 * @param run The run, null when there is none.
 */
function measureSpeeds (run: EnvironmentRunPayload | null): void {
  const at = Date.now()
  now.value = at
  const next: Record<string, TransferSpeed> = {}
  if (!run) {
    samples.clear()
    speeds.value = next
    return
  }
  for (const [index, { progress }] of run.steps.entries()) {
    const key = stepKey(run.id, index)
    const previous = samples.get(key)
    const known = speeds.value[key]
    if (!progress) {
      samples.delete(key)
    } else if (previous && progress.done === previous.done) {
      if (known) {
        next[key] = known
      }
    } else {
      if (previous && progress.done > previous.done && at > previous.at) {
        const measured = ((progress.done - previous.done) * 1000) / (at - previous.at)
        next[key] = { bytesPerSecond: known ? (known.bytesPerSecond + measured) / 2 : measured, movedAt: at }
      }
      samples.set(key, { done: progress.done, at })
    }
  }
  speeds.value = next
}

/**
 * Gives the speed to show for a step: none once its transfer is complete or has not moved lately.
 * @param runId The run.
 * @param index The step.
 * @param step The step.
 * @returns Its speed in bytes per second, null when none is shown.
 */
function speedOf (runId: string, index: number, { progress }: EnvironmentStepPayload): number | null {
  const speed = speeds.value[stepKey(runId, index)]
  if (!progress || !speed || (progress.total !== null && progress.done >= progress.total) || now.value - speed.movedAt > STALE_SPEED_MS) {
    return null
  }
  return speed.bytesPerSecond
}

/**
 * Finds an item of the environment.
 * @param itemPath The path of the item.
 * @returns The item, undefined when the environment has none at that path.
 */
function itemAt (itemPath: string): EnvironmentItemPayload | undefined {
  return state.value?.items.find(item => item.path === itemPath)
}

/**
 * Describes the local data a target replaces.
 * @param target The target.
 * @returns One line, null when the environment has no item at its path.
 */
function replacementOf (target: (typeof targets.value)[number]): string | null {
  const item = itemAt(target.path)
  if (!item) {
    return null
  }
  switch (item.kind) {
    case 'file':
      return target.keys ? `${item.path}: the chosen keys replaced` : `${item.path}: replaced by the copy of ${backendOf(item)}`
    case 'bucket':
      return `${item.path}: bucket ${item.bucket} replaced by its snapshot`
    case 'redis':
      return target.tables ? `${item.path}: key groups ${target.tables.join(', ')} emptied and reloaded` : `${item.path}: Redis database ${item.redis} emptied and reloaded`
    default:
      return target.tables
        ? `${item.path}: tables ${target.tables.join(', ')} emptied and reloaded`
        : `${item.path}: database ${item.database ? `${item.database} ` : ''}of container ${item.container} dropped and recreated`
  }
}

/**
 * Gives the selected items an action applies to: every one for a pull or a push, those whose local
 * data lives apart from their local copy for a restore or a removal, a restore of some tables needing
 * the item to allow it, and a removal taking the whole copy whatever tables are chosen.
 * @param action The action.
 * @returns The targets of the action.
 */
function targetsOf (action: EnvironmentAction): typeof targets.value {
  if (action !== 'restore' && action !== 'remove') {
    return targets.value
  }
  return targets.value
    .filter(target => {
      const item = itemAt(target.path)
      return item !== undefined && item.kind !== 'file' && item.local !== null && (action === 'remove' || target.tables === null || item.parts.pull)
    })
    .map(target => (action === 'remove' ? { ...target, tables: null } : target))
}

/**
 * Tells whether a selected item still waits for a choice: some tables or key groups not listed yet,
 * not listable or none chosen, or keys of a configuration file not compared yet or not comparable.
 * @param itemPath The path of the item.
 * @returns True when the item cannot be transferred yet.
 */
function isIncomplete (itemPath: string): boolean {
  const selection = selected.value[itemPath]
  if (!selection) {
    return false
  }
  const tables = environmentStore.tables.value[itemPath]
  const keys = environmentStore.keys.value[itemPath]
  return (selection.tables !== null && (selection.tables.length === 0 || !tables || tables.error !== null)) || (selection.keys !== null && (!keys || keys.error !== null))
}

/**
 * Tells whether an action can be started now: no run in progress, and items it applies to, none of
 * them waiting for a choice of tables or keys unless the action removes whole copies.
 * @param action The action.
 * @returns True when its button is enabled.
 */
function canRun (action: EnvironmentAction): boolean {
  const list = targetsOf(action)
  return !running.value && list.length > 0 && (action === 'remove' || !list.some(target => isIncomplete(target.path)))
}

/**
 * Tells whether an action can be run. A pull or a push needs the groups of the developer to let them
 * transfer every selected item, those restricted to some tables or key groups allowing it, or at
 * least one item while none is selected. A restore or a removal needs at least one selected item it
 * applies to.
 * @param action The action.
 * @returns True when the action is shown.
 */
function shows (action: EnvironmentAction): boolean {
  if (action === 'restore' || action === 'remove') {
    return targetsOf(action).length > 0
  }
  return selectedItems.value.length > 0
    ? selectedItems.value.every(item => item.allowed[action] && (selected.value[item.path].tables === null || item.parts[action]))
    : (state.value?.items ?? []).some(item => item.allowed[action])
}

/**
 * Runs an action over the selected items it applies to, after confirmation when it removes local
 * copies or replaces local data apart from configuration files.
 * @param action The action.
 */
function start (action: EnvironmentAction): void {
  const revision = state.value?.revision ?? 0
  if (action === 'push' || (action === 'pull' && !targets.value.some(target => (itemAt(target.path)?.kind ?? 'file') !== 'file'))) {
    wsStore.envRun(action, targets.value, revision)
    return
  }
  pendingAction.value = action
  confirmedTargets = JSON.stringify(targetsOf(action))
  confirmedRevision = revision
  confirmOpen.value = true
}

/**
 * Runs the action waiting for confirmation over the selected items it applies to, only when they
 * are still those the confirmation showed, the server refusing it once the configuration changed.
 */
function confirm (): void {
  if (pendingAction.value && canRun(pendingAction.value) && JSON.stringify(targetsOf(pendingAction.value)) === confirmedTargets) {
    wsStore.envRun(pendingAction.value, targetsOf(pendingAction.value), confirmedRevision)
  }
}

/**
 * Tells whether a step of the pull or push in progress can still be cancelled: it waits, or its file
 * has not fully moved yet.
 * @param step The step.
 * @returns True when its cancel button is shown.
 */
function cancellable (step: EnvironmentStepPayload): boolean {
  const run = state.value?.run
  if (!run || run.finished || (run.action !== 'pull' && run.action !== 'push')) {
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
    return remoteChangedSince(item.remote, item.synced) ? { label: `Newer on ${backendOf(item)}`, tone: 'remote' } : { label: 'Up to date', tone: 'synced' }
  }

  if (item.synced) {
    const localChanged = differs(item.local.updatedAt, item.synced.localUpdatedAt)
    const remoteChanged = remoteChangedSince(item.remote, item.synced)
    if (localChanged && remoteChanged) {
      return { label: 'Conflict', tone: 'conflict' }
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
 * Keeps the selection to what the items allow: an item no longer in the environment, or whose
 * chosen tables or keys can no longer be chosen, leaves the selection rather than being
 * transferred whole. The differing keys compared on copies that changed since are forgotten, the
 * choice of keys then starting over, and what the selection needs is asked for.
 * @param items The items of the environment.
 */
function reconcileSelection (items: EnvironmentItemPayload[]): void {
  const next: Record<string, ItemSelection> = {}
  for (const [path, selection] of Object.entries(selected.value)) {
    const item = items.find(candidate => candidate.path === path)
    if (item && (selection.tables === null || item.parts.pull || item.parts.push) && (selection.keys === null || hasKeys(item))) {
      next[path] = selection
    }
  }
  for (const item of items) {
    if (environmentStore.choices.isStale(choiceKey('keys', item.path), stampOf('keys', item))) {
      forgetChoices('keys', item.path)
      if (next[item.path]?.keys) {
        next[item.path] = { ...next[item.path], keys: {} }
      }
    }
  }
  if (Object.keys(next).length !== Object.keys(selected.value).length || Object.entries(next).some(([path, selection]) => selection !== selected.value[path])) {
    selected.value = next
  }
  askChoices()
}

/**
 * Forgets what the items were described with once they are described again: the tables of their
 * databases, which may have changed, and the keys that could not be compared, then asks again for
 * what the selection needs.
 */
function describedAgain (): void {
  for (const [path, answer] of Object.entries(environmentStore.keys.value)) {
    if (answer.error !== null) {
      forgetChoices('keys', path)
    }
  }
  for (const path of Object.keys(environmentStore.tables.value)) {
    forgetChoices('tables', path)
  }
  askChoices()
}

/**
 * Names a list of tables or of differing keys of an item.
 * @param kind Its tables or its keys.
 * @param path The path of the item.
 * @returns The name.
 */
function choiceKey (kind: ChoiceKind, path: string): string {
  return `${kind}:${path}`
}

/**
 * Gives what a list of tables or of differing keys of an item depends on: the copies of the item
 * for its keys, the latest description of the items for its tables.
 * @param kind Its tables or its keys.
 * @param item The item.
 * @returns A text changing whenever the list may change.
 */
function stampOf (kind: ChoiceKind, item: EnvironmentItemPayload): string {
  return kind === 'keys' ? JSON.stringify([item.local, item.remote]) : String(environmentStore.descriptions)
}

/**
 * Forgets a list of tables or of differing keys of an item.
 * @param kind Its tables or its keys.
 * @param path The path of the item.
 */
function forgetChoices (kind: ChoiceKind, path: string): void {
  environmentStore.choices.forget(choiceKey(kind, path))
  environmentStore.forget(path, kind)
}

/**
 * Asks the server for a list of tables or of differing keys of an item, unless it is known or
 * already asked for.
 * @param kind Its tables or its keys.
 * @param item The item.
 */
function askChoice (kind: ChoiceKind, item: EnvironmentItemPayload): void {
  const known = kind === 'tables' ? environmentStore.tables.value[item.path] : environmentStore.keys.value[item.path]
  if (known || !environmentStore.choices.ask(choiceKey(kind, item.path), stampOf(kind, item))) {
    return
  }
  if (kind === 'tables') {
    wsStore.envTables(item.path)
  } else {
    wsStore.envKeys(item.path)
  }
}

/**
 * Asks for the tables and the differing keys the selected items are restricted to.
 */
function askChoices (): void {
  for (const [path, selection] of Object.entries(selected.value)) {
    const item = itemAt(path)
    if (item && selection.tables !== null) {
      askChoice('tables', item)
    }
    if (item && selection.keys !== null) {
      askChoice('keys', item)
    }
  }
}

/**
 * Takes the lists of tables or of differing keys the server sent: a list that does not answer a
 * request made for what it depends on now is forgotten and asked for again when needed, and the
 * chosen tables are kept to those a database still holds.
 * @param kind Tables or keys.
 */
function settleAnswers (kind: ChoiceKind): void {
  const lists = kind === 'tables' ? environmentStore.tables.value : environmentStore.keys.value
  for (const path of Object.keys(lists)) {
    const item = itemAt(path)
    if (!environmentStore.choices.settle(choiceKey(kind, path), item ? stampOf(kind, item) : null)) {
      environmentStore.forget(path, kind)
    }
  }
  if (kind === 'tables') {
    keepExistingTables()
  }
  askChoices()
}

/**
 * Keeps the chosen tables or key groups of each database to those it still holds.
 */
function keepExistingTables (): void {
  let changed = false
  const next = { ...selected.value }
  for (const [path, selection] of Object.entries(selected.value)) {
    const list = environmentStore.tables.value[path]
    if (selection.tables === null || !list || list.error) {
      continue
    }
    const tables = selection.tables.filter(table => list.tables.includes(table))
    if (tables.length !== selection.tables.length) {
      next[path] = { ...selection, tables }
      changed = true
    }
  }
  if (changed) {
    selected.value = next
  }
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
  askChoices()
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
    forgetChoices('keys', path)
    askChoices()
  }
}

/**
 * Names the parts of an item that can be transferred without the rest.
 * @param item The item.
 * @returns "keys", "tables" or "key groups", null when the item is always transferred whole.
 */
function choosablePartsOf (item: EnvironmentItemPayload): string | null {
  if (hasKeys(item)) {
    return 'keys'
  }
  return item.parts.pull || item.parts.push ? partsOf(item) : null
}

/**
 * Tells whether only some tables, key groups or keys of a selected item are transferred.
 * @param path The path of the selected item.
 * @returns True when its parts are chosen, false when it is transferred whole.
 */
function choosesSome (path: string): boolean {
  const selection = selected.value[path]
  return selection !== undefined && (selection.tables ?? selection.keys) !== null
}

/**
 * Chooses between transferring an item whole and some of its tables, key groups or keys, keeping
 * the parts already chosen when the choice stays the same.
 * @param item The item.
 * @param some Whether only some of its parts are transferred.
 */
function chooseScope (item: EnvironmentItemPayload, some: boolean): void {
  if (choosesSome(item.path) === some) {
    return
  }
  if (hasKeys(item)) {
    chooseWholeFile(item.path, !some)
  } else {
    chooseWhole(item.path, !some)
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
 * @returns Its relative date and size, or "size unknown" when its backend does not give it.
 */
function copyLabel (copy: EnvironmentCopyPayload): string {
  return `${formatRelativeDate(copy.updatedAt)} · ${sizeLabel(copy.size)}`
}

/**
 * Formats the size of a copy.
 * @param size The size in bytes, null when its backend does not give it.
 * @returns The size, or a text telling it is unknown.
 */
function sizeLabel (size: number | null): string {
  return size === null ? 'size unknown' : formatBytes(size)
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

onMounted(() => {
  settleAnswers('tables')
  settleAnswers('keys')
  wsStore.envRefresh()
})
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
          <div class="flex flex-wrap items-center gap-2">
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
              :disabled="running || state?.refreshing"
              @click="wsStore.envRefresh()"
            >
              <RefreshCw :class="cn('size-3.5', state?.refreshing && 'animate-spin')" />
              {{ state?.refreshing ? "Refreshing…" : "Refresh" }}
            </Button>
          </div>
        </div>

        <div
          v-if="signInNeeded && session"
          class="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 p-3"
        >
          <div class="flex min-w-0 items-center gap-2 text-sm">
            <UserRound class="size-4 shrink-0 text-muted-foreground" />
            Not signed in: the copies of the cdn backends are unknown and cannot be transferred.
          </div>
          <Button
            v-if="!session.pendingLoginUrl"
            size="sm"
            class="max-w-full"
            :title="`Sign in${session.providerName ? ` with ${session.providerName}` : ''}`"
            @click="login"
          >
            <span class="truncate">Sign in{{ session.providerName ? ` with ${session.providerName}` : "" }}</span>
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
          <span class="min-w-0 break-words">{{ state.error }}</span>
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
          class="@container gap-0 overflow-hidden py-0"
        >
          <div class="flex items-center justify-between border-b bg-muted/40 px-4 py-2">
            <label class="flex min-w-0 items-center gap-3">
              <Checkbox
                :model-value="selectionState(group.items)"
                :disabled="running"
                @update:model-value="(checked) => selectAll(group.items, checked === true)"
              />
              <span
                class="truncate text-xs font-semibold tracking-wide text-muted-foreground"
                :title="group.section"
              >{{ group.section }}</span>
            </label>
            <span class="shrink-0 pl-3 text-xs text-muted-foreground">{{ group.items.length }} {{ group.items.length > 1 ? "items" : "item" }}</span>
          </div>

          <fieldset
            v-for="item in group.items"
            :key="item.path"
            :disabled="running"
            :class="cn(
              'min-w-0 border-b transition-colors last:border-b-0',
              selected[item.path] && 'bg-accent/30',
              running ? 'pointer-events-none opacity-70' : 'hover:bg-accent/40',
            )"
          >
            <div
              class="grid cursor-pointer grid-cols-[auto_auto_minmax(0,1fr)_minmax(0,1fr)_fit-content(min(30%,9rem))] items-center gap-x-3 gap-y-1.5 px-4 py-3 @md:grid-cols-[auto_auto_minmax(0,1fr)_minmax(0,1fr)_min(30%,9rem)] @4xl:grid-cols-[auto_auto_minmax(0,1fr)_11rem_11rem_9rem]"
              @click="selectAll([item], !selected[item.path])"
            >
              <Checkbox
                class="row-span-4 @md:row-span-2 @4xl:row-span-1"
                :model-value="Boolean(selected[item.path])"
                @click.stop
                @update:model-value="(checked) => selectAll([item], checked === true)"
              />
              <div class="row-span-4 flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground @md:row-span-2 @4xl:row-span-1">
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
              <div class="col-start-3 col-end-6 row-start-1 min-w-0 @md:col-end-5 @4xl:col-start-auto @4xl:col-end-auto @4xl:row-start-auto">
                <div class="flex items-center gap-1.5">
                  <span
                    class="truncate font-mono text-sm"
                    :title="item.path"
                  >{{ item.path }}</span>
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
                <div
                  class="truncate text-xs text-muted-foreground"
                  :title="describeItem(item)"
                >
                  {{ describeItem(item) }}
                  <template v-if="item.pem?.kind === 'certificate'">
                    · <span :class="expiryClass(item.pem.expiresAt)">{{ expiryLabel(item.pem.expiresAt) }}</span>
                  </template>
                </div>
                <div
                  v-if="selected[item.path] && choosablePartsOf(item)"
                  role="group"
                  :aria-label="`Part of ${item.path} to transfer`"
                  class="mt-1.5 inline-flex max-w-full flex-wrap rounded-md border p-0.5 text-xs"
                  @click.stop
                >
                  <button
                    v-for="some in [false, true]"
                    :key="String(some)"
                    type="button"
                    :aria-pressed="choosesSome(item.path) === some"
                    :class="cn(
                      'rounded px-2 py-0.5 transition-colors',
                      choosesSome(item.path) === some ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                    )"
                    @click="chooseScope(item, some)"
                  >
                    {{ some ? `Some ${choosablePartsOf(item)}` : item.kind === 'file' ? 'Whole file' : 'Whole database' }}
                  </button>
                </div>
              </div>
              <div class="col-start-3 col-end-6 row-start-2 flex min-w-0 items-baseline gap-2 text-xs @md:col-end-4 @md:block @4xl:col-start-auto @4xl:col-end-auto @4xl:row-start-auto">
                <div class="shrink-0 text-muted-foreground">
                  Local
                </div>
                <div
                  class="min-w-0 truncate"
                  :title="item.local ? copyLabel(item.local) : undefined"
                >
                  {{ item.local ? copyLabel(item.local) : "—" }}
                </div>
              </div>
              <div class="col-start-3 col-end-6 row-start-3 flex min-w-0 items-baseline gap-2 text-xs @md:col-start-4 @md:col-end-5 @md:row-start-2 @md:block @4xl:col-start-auto @4xl:col-end-auto @4xl:row-start-auto">
                <div class="flex max-w-1/2 min-w-0 shrink-0 items-center gap-1 text-muted-foreground @md:max-w-full">
                  <span
                    class="truncate"
                    :title="backendOf(item)"
                  >{{ backendOf(item) }}</span>
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
                <div
                  class="min-w-0 truncate"
                  :title="item.remote && item.remote !== 'unknown' ? copyLabel(item.remote) : undefined"
                >
                  {{ item.remote === "unknown" ? "Unknown" : item.remote ? copyLabel(item.remote) : "—" }}
                </div>
              </div>
              <div class="col-start-3 col-end-6 row-start-4 flex min-w-0 @md:col-start-5 @md:col-end-6 @md:row-start-1 @md:row-end-3 @md:justify-end @4xl:col-start-auto @4xl:col-end-auto @4xl:row-start-auto @4xl:row-end-auto">
                <Badge
                  v-if="syncStatus(item)"
                  variant="outline"
                  :class="cn('max-w-full', TONE_CLASSES[syncStatus(item)!.tone])"
                  :title="syncStatus(item)!.label"
                >
                  <span class="truncate">{{ syncStatus(item)!.label }}</span>
                </Badge>
              </div>
            </div>

            <div
              v-if="hasKeys(item) && selected[item.path]?.keys"
              class="px-4 pb-4 @md:pl-[5.5rem]"
            >
              <div
                v-if="!environmentStore.keys.value[item.path]"
                class="flex items-center gap-2 text-xs text-muted-foreground"
              >
                <Loader2 class="size-3.5 animate-spin" />
                Comparing the local and {{ backendOf(item) }} copies…
              </div>
              <div
                v-else-if="environmentStore.keys.value[item.path].error"
                class="text-xs break-words text-destructive"
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
            </div>

            <div
              v-if="(item.parts.pull || item.parts.push) && selected[item.path]?.tables"
              class="space-y-2 px-4 pb-4 @md:pl-[5.5rem]"
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
                class="text-xs break-words text-destructive"
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
                      'max-w-full truncate rounded-full border px-2.5 py-0.5 font-mono text-xs transition-colors',
                      selected[item.path].tables!.includes(table) ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent',
                    )"
                    :title="table"
                    :aria-pressed="selected[item.path].tables!.includes(table)"
                    @click="toggleTable(item.path, table)"
                  >
                    {{ table }}
                  </button>
                </div>
              </template>
            </div>
          </fieldset>
        </Card>
      </div>
    </div>

    <div
      v-if="state?.run"
      class="flex max-h-[min(16rem,35dvh)] shrink-0 flex-col gap-2 border-t bg-card px-6 py-3"
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
            @click="wsStore.envDismissRun(state.run.id)"
          >
            <X class="size-4" />
          </Button>
        </div>
      </div>
      <div class="@container mx-auto min-h-0 w-full max-w-5xl space-y-2 overflow-auto">
        <div
          v-for="(step, index) in state.run.steps"
          :key="index"
          class="flex flex-wrap items-start gap-x-2 gap-y-1 text-sm"
        >
          <span class="mt-0.5 size-4 shrink-0 overflow-hidden">
            <component
              :is="stepIcon(step).icon"
              :class="cn('size-4', stepIcon(step).class)"
            />
          </span>
          <span
            class="max-w-2/3 min-w-0 shrink-0 truncate font-mono text-xs leading-5 @md:max-w-1/2"
            :title="step.target"
          >{{ step.target }}</span>
          <span
            v-if="step.progress"
            class="order-last flex min-w-0 basis-full items-center gap-2 pl-6 text-xs leading-5 text-muted-foreground tabular-nums @md:order-none @md:ml-auto @md:basis-auto @md:pl-0"
          >
            <span
              class="min-w-0 flex-1 truncate text-right @md:w-64 @md:flex-none"
              :title="formatProgress(step.progress.done, step.progress.total, speedOf(state.run.id, index, step))"
            >{{ formatProgress(step.progress.done, step.progress.total, speedOf(state.run.id, index, step)) }}</span>
            <span class="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
              <span
                v-if="progressPercent(step.progress.done, step.progress.total) !== null"
                class="block h-full rounded-full bg-sky-500 transition-[width]"
                :style="{ width: `${progressPercent(step.progress.done, step.progress.total)}%` }"
              />
              <span
                v-else
                class="block h-full w-1/3 animate-indeterminate rounded-full bg-sky-500"
              />
            </span>
          </span>
          <span
            v-if="step.detail"
            :class="cn('min-w-0 flex-1 basis-0 truncate text-xs leading-5', step.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')"
            :title="step.detail"
          >{{ step.detail }}</span>
          <Button
            v-if="cancellable(step)"
            size="icon"
            variant="ghost"
            :class="cn('ml-auto size-5 shrink-0', step.progress && '@md:ml-0')"
            title="Cancel the transfer of this item"
            :aria-label="`Cancel the transfer of ${step.target}`"
            @click="wsStore.envCancel(state.run.id, index)"
          >
            <X class="size-3.5" />
          </Button>
        </div>
      </div>
    </div>

    <div class="shrink-0 border-t bg-background px-6 py-3">
      <div class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
        <div class="flex min-w-0 items-center gap-3 text-sm text-muted-foreground">
          <Checkbox
            aria-label="Select all items"
            :model-value="selectionState(state?.items ?? [])"
            :disabled="running || !state?.items.length"
            @update:model-value="(checked) => selectAll(state?.items ?? [], checked === true)"
          />
          <span
            class="min-w-0 truncate"
            :title="selectionHint"
          >{{ selectionHint }}</span>
        </div>
        <div
          v-if="state?.run?.steps.some(cancellable)"
          class="ml-auto flex items-center gap-2"
        >
          <Button
            variant="outline"
            class="gap-1.5"
            @click="wsStore.envCancel(state.run.id, null)"
          >
            <X class="size-4" />
            Cancel {{ state.run.action }}
          </Button>
        </div>
        <div
          v-else
          class="ml-auto flex flex-wrap items-center justify-end gap-2"
        >
          <Button
            v-if="shows('remove')"
            variant="ghost"
            class="gap-1.5"
            :disabled="!canRun('remove')"
            @click="start('remove')"
          >
            <Trash2 class="size-4" />
            Remove local copy
          </Button>
          <Button
            v-if="shows('restore')"
            variant="outline"
            class="gap-1.5"
            :disabled="!canRun('restore')"
            @click="start('restore')"
          >
            <RotateCcw class="size-4" />
            Restore
          </Button>
          <Button
            v-if="shows('push')"
            variant="outline"
            class="gap-1.5"
            :disabled="!canRun('push')"
            @click="start('push')"
          >
            <ArrowUpFromLine class="size-4" />
            Push
          </Button>
          <Button
            v-if="shows('pull')"
            class="gap-1.5"
            :disabled="!canRun('pull')"
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
      :disabled="pendingAction === null || !canRun(pendingAction)"
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
