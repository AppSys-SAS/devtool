<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui";
import McpConnectionCard from "@/components/mcp/McpConnectionCard.vue";
import McpGrantsCard from "@/components/mcp/McpGrantsCard.vue";
import McpHistoryCard from "@/components/mcp/McpHistoryCard.vue";
import McpPendingCard from "@/components/mcp/McpPendingCard.vue";
import McpPermissionsCard from "@/components/mcp/McpPermissionsCard.vue";
import configStore from "@/stores/config";
import mcpStore from "@/stores/mcp";

const route = useRoute();
const router = useRouter();

const tab = computed({
  get: () => (typeof route.query.tab === "string" ? route.query.tab : ""),
  set: (value) => void router.replace({ query: { ...route.query, tab: value } }),
});

if (!tab.value) {
  tab.value = mcpStore.state.value?.pending.length ? "waiting" : "connection";
}

const tabs = computed(() => [
  { value: "connection", label: "Connection", count: mcpStore.state.value?.sessions.length ?? 0 },
  { value: "waiting", label: "Waiting", count: mcpStore.state.value?.pending.length ?? 0 },
  { value: "history", label: "History", count: mcpStore.history.value.length },
  { value: "grants", label: "Grants", count: mcpStore.state.value?.grants.length ?? 0 },
  { value: "permissions", label: "Permissions", count: 0 },
]);
</script>

<template>
  <div class="h-full overflow-auto p-6">
    <div class="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 class="text-xl font-semibold">
          Agents
        </h1>
        <p class="text-sm text-muted-foreground">
          The MCP server lets agents such as Claude Code see and use the terminals, commands, files and environment of the devtool, within the rules of <code>adt.mcp</code>.
        </p>
      </div>
      <p
        v-if="!configStore.mcp.value?.enabled"
        class="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
      >
        The MCP server is off: set <code>adt.mcp.enabled: true</code> in the configuration.
      </p>
      <TabsRoot
        v-else
        v-model="tab"
        class="space-y-4"
      >
        <TabsList class="flex gap-1 border-b">
          <TabsTrigger
            v-for="item in tabs"
            :key="item.value"
            :value="item.value"
            class="-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground"
          >
            {{ item.label }}
            <span
              v-if="item.count"
              class="rounded-full px-1.5 text-[11px] tabular-nums"
              :class="item.value === 'waiting' ? 'bg-amber-500 text-white' : 'bg-muted text-muted-foreground'"
            >{{ item.count }}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="connection">
          <McpConnectionCard />
        </TabsContent>
        <TabsContent value="waiting">
          <McpPendingCard />
        </TabsContent>
        <TabsContent value="history">
          <McpHistoryCard />
        </TabsContent>
        <TabsContent value="grants">
          <McpGrantsCard />
        </TabsContent>
        <TabsContent value="permissions">
          <McpPermissionsCard />
        </TabsContent>
      </TabsRoot>
    </div>
  </div>
</template>
