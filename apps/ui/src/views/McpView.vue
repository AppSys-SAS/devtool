<script setup lang="ts">
import McpConnectionCard from "@/components/mcp/McpConnectionCard.vue";
import McpGrantsCard from "@/components/mcp/McpGrantsCard.vue";
import McpHistoryCard from "@/components/mcp/McpHistoryCard.vue";
import McpPendingCard from "@/components/mcp/McpPendingCard.vue";
import McpPermissionsCard from "@/components/mcp/McpPermissionsCard.vue";
import configStore from "@/stores/config";
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
      <template v-else>
        <McpPendingCard />
        <McpConnectionCard />
        <McpHistoryCard />
        <McpGrantsCard />
        <McpPermissionsCard />
      </template>
    </div>
  </div>
</template>
