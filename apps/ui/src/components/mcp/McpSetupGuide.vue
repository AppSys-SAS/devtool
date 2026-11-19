<script setup lang="ts">
import { computed } from "vue";
import { useLocalStorage } from "@vueuse/core";
import McpCopyBlock from "@/components/mcp/McpCopyBlock.vue";
import { Select } from "@/components/ui/select";
import { MCP_AGENTS } from "@/lib/mcp";
import configStore from "@/stores/config";

const props = defineProps<{
  /** The port of the devtool server. */
  port: number;
}>();

const options = MCP_AGENTS.map((agent) => ({ label: agent.label, value: agent.id, icon: agent.icon }));
const chosen = useLocalStorage("appsys-devtool-mcp-agent", MCP_AGENTS[0].id);
if (!MCP_AGENTS.some((agent) => agent.id === chosen.value)) {
  chosen.value = MCP_AGENTS[0].id;
}
const setup = computed(() => (MCP_AGENTS.find((agent) => agent.id === chosen.value) ?? MCP_AGENTS[0]).setup(configStore.name.value, `http://127.0.0.1:${props.port}/mcp`));
</script>

<template>
  <div class="space-y-2">
    <Select
      v-model="chosen"
      :options="options"
      class="w-64"
    />
    <McpCopyBlock
      v-if="setup.command"
      :text="setup.command"
    />
    <p
      v-if="setup.file"
      class="text-xs text-muted-foreground"
    >
      {{ setup.command ? "Or add" : "Add" }} to <code>{{ setup.file }}</code>:
    </p>
    <McpCopyBlock
      v-if="setup.config"
      :text="setup.config"
    />
    <p
      v-if="setup.note"
      class="text-xs text-muted-foreground"
    >
      {{ setup.note }}
    </p>
  </div>
</template>
