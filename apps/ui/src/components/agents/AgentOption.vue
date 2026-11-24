<script setup lang="ts">
import { Icon } from "@iconify/vue";
import type { AgentDefinition } from "@appsys/devtool-shared";

defineProps<{
  agent: AgentDefinition;
}>();
</script>

<template>
  <span class="flex min-w-0 items-start gap-2 text-sm">
    <Icon
      :icon="agent.icon"
      class="mt-0.5 size-4 shrink-0"
    />
    <span class="min-w-0">
      <span class="block truncate font-medium">{{ agent.name }}</span>
      <span class="block truncate text-xs text-muted-foreground">{{ agent.args ? "Terminal of the project" : "Link opened by the browser" }}</span>
    </span>
  </span>
</template>
