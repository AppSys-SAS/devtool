<script setup lang="ts">
import { shallowRef } from "vue";
import { RouterLink } from "vue-router";
import { ChevronRight, CircleAlert, CircleCheck, SquareTerminal } from "@lucide/vue";
import type { McpGrantPayload, McpHistoryEntry } from "@appsys/devtool-shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DECISIONS } from "@/lib/mcp";

defineProps<{
  entry: McpHistoryEntry;
  /** The grants of the key of the call. */
  grants: McpGrantPayload[];
  /** Whether the session of the call is still open. */
  sessionOpen: boolean;
  /** Whether its terminal still exists. */
  terminalOpen: boolean;
}>();

const emit = defineEmits<{
  grant: [scope: "session" | "always"];
  revoke: [grant: McpGrantPayload];
}>();

const expanded = shallowRef(false);
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
      <span class="w-28 shrink-0 truncate">{{ entry.client }}</span>
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
      <span class="w-14 shrink-0 text-right tabular-nums text-muted-foreground">{{ entry.duration }} ms</span>
    </button>

    <div
      v-if="expanded"
      class="space-y-2 border-t px-3 py-2 text-xs"
    >
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
      <dl
        v-if="entry.details.length"
        class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1"
      >
        <template
          v-for="(detail, index) in entry.details"
          :key="index"
        >
          <dt class="text-muted-foreground">
            {{ detail.label }}
          </dt>
          <dd class="max-h-24 overflow-auto font-mono whitespace-pre-wrap break-all">
            {{ detail.value }}
          </dd>
        </template>
      </dl>
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
