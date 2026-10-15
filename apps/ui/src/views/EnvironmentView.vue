<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  CircleDashed,
  Database,
  FileText,
  Loader2,
  Package,
  RefreshCw,
  SkipForward,
  TriangleAlert,
  UserRound,
  X,
} from "@lucide/vue";
import type { EnvironmentCopyPayload, EnvironmentItemPayload, EnvironmentKeyChoicePayload, EnvironmentStepPayload } from "@appsys/devtool-shared";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import YamlKeyChooser from "@/components/YamlKeyChooser.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { formatBytes, formatRelativeDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import environmentStore from "@/stores/environment";
import sessionStore from "@/stores/session";
import wsStore from "@/stores/ws";

interface SyncStatus {
  label: string;
  tone: "remote" | "local" | "conflict" | "muted" | "synced";
}

type Side = EnvironmentKeyChoicePayload["side"];

interface ItemSelection {
  tables: string[] | null;
  keys: Record<string, Side> | null;
}

const SAME_DATE_TOLERANCE_MS = 1000;
const TONE_CLASSES: Record<SyncStatus["tone"], string> = {
  remote: "border-sky-500/40 text-sky-600 dark:text-sky-400",
  local: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  conflict: "border-destructive/40 text-destructive",
  muted: "text-muted-foreground",
  synced: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
};

const state = environmentStore.state;
const session = sessionStore.state;
const selected = ref<Record<string, ItemSelection>>({});
const tableFilters = ref<Record<string, string>>({});
const confirmOpen = ref(false);
const pullingConfig = ref(false);
const runDismissed = ref(false);

const signedIn = computed(() => session.value?.signedIn === true);
const running = computed(() => state.value?.run?.finished === false);

watch(running, (isRunning) => {
  if (isRunning) {
    runDismissed.value = false;
    return;
  }

  for (const [path, selection] of Object.entries(selected.value)) {
    if (selection.keys !== null) {
      chooseWholeFile(path, false);
    }
  }
});

const groups = computed(() => {
  const byProject = new Map<string, EnvironmentItemPayload[]>();
  for (const item of state.value?.items ?? []) {
    const project = item.path.split("/")[0];
    byProject.set(project, [...(byProject.get(project) ?? []), item]);
  }

  return [...byProject.entries()].map(([project, items]) => ({ project, items }));
});

const targets = computed(() =>
  Object.entries(selected.value).map(([path, { tables, keys }]) => {
    const entries = keys ? environmentStore.keys.value[path]?.entries : undefined;
    const item = state.value?.items.find((candidate) => candidate.path === path);
    return {
      path,
      tables,
      keys: entries && keys ? entries.map((entry) => ({ path: entry.path, side: keys[JSON.stringify(entry.path)] ?? (item ? defaultSideOf(item) : "remote") })) : null,
    };
  }),
);
const incomplete = computed(() =>
  Object.entries(selected.value).some(
    ([path, { tables, keys }]) => (tables !== null && tables.length === 0) || (keys !== null && (!environmentStore.keys.value[path] || environmentStore.keys.value[path].error !== null)),
  ),
);
const canRun = computed(() => signedIn.value && !running.value && targets.value.length > 0 && !incomplete.value);

const overwritten = computed(() =>
  targets.value
    .map((target) => ({ target, item: state.value?.items.find((item) => item.path === target.path) }))
    .filter(({ item }) => item && item.kind !== "file")
    .map(({ target, item }) => {
      if (item?.kind === "bucket") {
        return `${item.path}: bucket ${item.bucket} emptied and reloaded`;
      }

      return target.tables
        ? `${target.path}: tables ${target.tables.join(", ")} emptied and reloaded`
        : `${target.path}: database of container ${item?.container} dropped and recreated`;
    }),
);

/**
 * Compares the local copy of an item with its copy on the CDN.
 * @param item The item.
 * @returns The status to show, or null when the CDN copies are unknown.
 */
function syncStatus(item: EnvironmentItemPayload): SyncStatus | null {
  if (item.remote === "unknown") {
    return null;
  }

  if (!item.remote) {
    return item.local ? { label: "Only local", tone: "local" } : { label: "Missing", tone: "muted" };
  }

  if (!item.local) {
    return { label: "Only on CDN", tone: "remote" };
  }

  if (item.synced) {
    const localChanged = Math.abs(new Date(item.local.updatedAt).getTime() - new Date(item.synced.localUpdatedAt).getTime()) > SAME_DATE_TOLERANCE_MS;
    const remoteChanged = Math.abs(new Date(item.remote.updatedAt).getTime() - new Date(item.synced.remoteUpdatedAt).getTime()) > SAME_DATE_TOLERANCE_MS;
    if (localChanged && remoteChanged) {
      return { label: "Changed on both", tone: "conflict" };
    }

    if (localChanged || remoteChanged) {
      return localChanged ? { label: "Newer locally", tone: "local" } : { label: "Newer on CDN", tone: "remote" };
    }

    return { label: "Up to date", tone: "synced" };
  }

  const difference = new Date(item.remote.updatedAt).getTime() - new Date(item.local.updatedAt).getTime();
  if (Math.abs(difference) <= SAME_DATE_TOLERANCE_MS) {
    return { label: "Up to date", tone: "synced" };
  }

  return difference > 0 ? { label: "Newer on CDN", tone: "remote" } : { label: "Newer locally", tone: "local" };
}

/**
 * Describes what an item holds.
 * @param item The item.
 * @returns A short description.
 */
function describeItem(item: EnvironmentItemPayload): string {
  if (item.kind === "database") {
    return `${item.engine} · container ${item.container}`;
  }

  return item.kind === "bucket" ? `bucket ${item.bucket}` : "file";
}

/**
 * Selects or unselects an item.
 * @param item The item.
 * @param checked Whether it is selected.
 */
function toggleItem(item: EnvironmentItemPayload, checked: boolean): void {
  const next = { ...selected.value };
  if (checked) {
    next[item.path] = { tables: null, keys: null };
  } else {
    delete next[item.path];
  }
  selected.value = next;
}

/**
 * Chooses between the whole database and some of its tables.
 * @param path The path of the database item.
 * @param whole Whether the whole database is transferred.
 */
function chooseWhole(path: string, whole: boolean): void {
  selected.value = { ...selected.value, [path]: { tables: whole ? null : [], keys: null } };
  if (!whole && !environmentStore.tables.value[path]) {
    wsStore.envTables(path);
  }
}

/**
 * Tells whether the keys of an item can be chosen one by one: a YAML file present on both sides.
 * @param item The item.
 * @returns True for such a file.
 */
function hasKeys(item: EnvironmentItemPayload): boolean {
  return item.kind === "file" && /\.ya?ml$/.test(item.path) && item.local !== null && item.remote !== null && item.remote !== "unknown";
}

/**
 * Gives the copy a differing key takes until the developer chooses: the newer one.
 * @param item The YAML file item.
 * @returns The CDN when its copy is newer, the local copy otherwise.
 */
function defaultSideOf(item: EnvironmentItemPayload): Side {
  return syncStatus(item)?.tone === "local" ? "local" : "remote";
}

/**
 * Chooses between the whole file and some of its keys, asking the server for the differing keys.
 * @param path The path of the YAML file item.
 * @param whole Whether the whole file is transferred.
 */
function chooseWholeFile(path: string, whole: boolean): void {
  selected.value = { ...selected.value, [path]: { tables: null, keys: whole ? null : {} } };
  if (!whole) {
    environmentStore.forgetKeys(path);
    wsStore.envKeys(path);
  }
}

/**
 * Keeps the copies chosen for the differing keys of a YAML file.
 * @param path The path of the YAML file item.
 * @param keys The copy of each key.
 */
function setKeys(path: string, keys: Record<string, Side>): void {
  selected.value = { ...selected.value, [path]: { tables: null, keys } };
}

/**
 * Selects or unselects a table of a database.
 * @param path The path of the database item.
 * @param table The table.
 */
function toggleTable(path: string, table: string): void {
  const tables = selected.value[path]?.tables ?? [];
  const next = tables.includes(table) ? tables.filter((candidate) => candidate !== table) : [...tables, table];
  selected.value = { ...selected.value, [path]: { tables: next, keys: null } };
}

/**
 * Lists the tables of a database matching its filter.
 * @param path The path of the database item.
 * @returns The tables.
 */
function visibleTables(path: string): string[] {
  const filter = (tableFilters.value[path] ?? "").toLowerCase();
  return (environmentStore.tables.value[path]?.tables ?? []).filter((table) => table.toLowerCase().includes(filter));
}

/**
 * Selects the items whose CDN copy is newer than the local one, or only on the CDN.
 */
function selectNewerOnCdn(): void {
  selected.value = Object.fromEntries(
    (state.value?.items ?? []).filter((item) => syncStatus(item)?.tone === "remote").map((item) => [item.path, { tables: null, keys: null }]),
  );
}

/**
 * Pulls the selected items, after confirmation when local data is replaced.
 */
function pull(): void {
  if (overwritten.value.length > 0) {
    confirmOpen.value = true;
    return;
  }

  wsStore.envRun("pull", targets.value);
}

/**
 * Starts a sign-in, in a new tab.
 */
function login(): void {
  sessionStore.openLoginWindow();
  wsStore.cdnLogin();
}

/**
 * Names the date and size of a copy.
 * @param copy The copy.
 * @returns Its relative date and size.
 */
function copyLabel(copy: EnvironmentCopyPayload): string {
  return `${formatRelativeDate(copy.updatedAt)} · ${formatBytes(copy.size)}`;
}

/**
 * Gives the icon of a progress step.
 * @param step The step.
 * @returns The icon component and its classes.
 */
function stepIcon(step: EnvironmentStepPayload): { icon: unknown; class: string } {
  switch (step.status) {
    case "running":
      return { icon: Loader2, class: "animate-spin text-sky-500" };
    case "done":
      return { icon: Check, class: "text-emerald-500" };
    case "skipped":
      return { icon: SkipForward, class: "text-amber-500" };
    case "failed":
      return { icon: X, class: "text-destructive" };
    default:
      return { icon: CircleDashed, class: "text-muted-foreground" };
  }
}

/**
 * Downloads the shared devtool configuration, which declares the environment.
 */
function pullConfig(): void {
  pullingConfig.value = true;
  wsStore.envPullConfig();
}

watch(state, () => {
  pullingConfig.value = false;
});

onMounted(() => wsStore.envRefresh());
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
              Configurations, databases and buckets shared by the developers: <code>~/.config/appsys</code> ⇄ CDN.
            </p>
          </div>
          <div class="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              :disabled="running || !state?.items.length"
              @click="selectNewerOnCdn"
            >
              Select newer on CDN
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
          v-if="session?.configured && !signedIn"
          class="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 p-3"
        >
          <div class="flex items-center gap-2 text-sm">
            <UserRound class="size-4 text-muted-foreground" />
            Not signed in: the CDN copies are unknown and nothing can be transferred.
          </div>
          <Button
            v-if="!session.pendingLoginUrl"
            size="sm"
            @click="login"
          >
            Sign in
          </Button>
          <span
            v-else
            class="text-xs text-muted-foreground"
          >Waiting for Authelia…</span>
        </div>

        <div
          v-else-if="state?.error"
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
            <p
              v-if="session?.configured"
              class="text-sm text-muted-foreground"
            >
              The shared devtool configuration declares it: pull it from the CDN to list the configurations, databases and buckets.
            </p>
            <p
              v-else
              class="text-sm text-muted-foreground"
            >
              Add a <code>cdn</code> section to <code>devtool-config.yml</code> to get the shared devtool configuration.
            </p>
          </div>
          <Button
            v-if="session?.configured"
            class="gap-1.5"
            :disabled="!signedIn || pullingConfig"
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
          :key="group.project"
          class="gap-0 overflow-hidden py-0"
        >
          <div class="flex items-center justify-between border-b bg-muted/40 px-4 py-2">
            <span class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{{ group.project }}</span>
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
              @click="toggleItem(item, !selected[item.path])"
            >
              <Checkbox
                :model-value="Boolean(selected[item.path])"
                @click.stop
                @update:model-value="(checked) => toggleItem(item, checked === true)"
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
                <FileText
                  v-else
                  class="size-4"
                />
              </div>
              <div class="min-w-0">
                <div class="truncate font-mono text-sm">
                  {{ item.path }}
                </div>
                <div class="truncate text-xs text-muted-foreground">
                  {{ describeItem(item) }}
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
                <div class="text-muted-foreground">
                  CDN
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
                  Comparing the local and CDN copies…
                </div>
                <div
                  v-else-if="environmentStore.keys.value[item.path].error"
                  class="text-xs text-destructive"
                >
                  {{ environmentStore.keys.value[item.path].error }}
                </div>
                <YamlKeyChooser
                  v-else
                  :model-value="selected[item.path].keys!"
                  :entries="environmentStore.keys.value[item.path].entries"
                  :default-side="defaultSideOf(item)"
                  @update:model-value="(keys) => setKeys(item.path, keys)"
                />
              </template>
            </div>

            <div
              v-if="item.kind === 'database' && selected[item.path]"
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
                  Some tables
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
                  Loading the tables of {{ item.container }}…
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
                      placeholder="Filter tables"
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
      v-if="state?.run && !runDismissed"
      class="max-h-64 shrink-0 overflow-auto border-t bg-card px-6 py-3"
    >
      <div class="mx-auto max-w-5xl space-y-2">
        <div class="flex items-center justify-between gap-2">
          <span class="text-sm font-medium">
            {{ state.run.direction === "pull" ? "Pull" : "Push" }} {{ state.run.finished ? "finished" : "in progress" }}
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
              @click="runDismissed = true"
            >
              <X class="size-4" />
            </Button>
          </div>
        </div>
        <div
          v-for="step in state.run.steps"
          :key="step.target"
          class="flex items-start gap-2 text-sm"
        >
          <component
            :is="stepIcon(step).icon"
            :class="cn('mt-0.5 size-4 shrink-0', stepIcon(step).class)"
          />
          <span class="shrink-0 font-mono text-xs leading-5">{{ step.target }}</span>
          <span
            v-if="step.detail"
            :class="cn('min-w-0 truncate text-xs leading-5', step.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')"
            :title="step.detail"
          >{{ step.detail }}</span>
        </div>
      </div>
    </div>

    <div class="shrink-0 border-t bg-background px-6 py-3">
      <div class="mx-auto flex max-w-5xl items-center justify-between gap-3">
        <span class="text-sm text-muted-foreground">
          <template v-if="targets.length === 0">Select items to transfer.</template>
          <template v-else-if="incomplete">Choose at least one table for each database restricted to tables.</template>
          <template v-else>{{ targets.length }} {{ targets.length > 1 ? "items" : "item" }} selected</template>
        </span>
        <div class="flex items-center gap-2">
          <Button
            variant="outline"
            class="gap-1.5"
            :disabled="!canRun"
            @click="wsStore.envRun('push', targets)"
          >
            <ArrowUpFromLine class="size-4" />
            Push
          </Button>
          <Button
            class="gap-1.5"
            :disabled="!canRun"
            @click="pull"
          >
            <ArrowDownToLine class="size-4" />
            Pull
          </Button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      v-model:open="confirmOpen"
      title="Replace local data?"
      confirm-label="Pull and replace"
      @confirm="wsStore.envRun('pull', targets)"
    >
      <p>The CDN copies will replace your local data:</p>
      <ul class="mt-2 list-disc space-y-1 pl-5">
        <li
          v-for="line in overwritten"
          :key="line"
        >
          {{ line }}
        </li>
      </ul>
    </ConfirmDialog>
  </div>
</template>
