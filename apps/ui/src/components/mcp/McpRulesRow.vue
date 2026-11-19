<script setup lang="ts">
import { MCP_ACTIONS, type McpAction, type McpRules } from "@appsys/devtool-shared";
import { Badge } from "@/components/ui/badge";
import { LEVELS } from "@/lib/mcp";

defineProps<{
  label: string;
  /** What the row is, such as a section, a command or a script. */
  kind: string;
  rules: McpRules;
  /** The actions shown. */
  actions: readonly McpAction[];
  depth: number;
  /** Names the row in the grants, `<action>:<grantId>` being granted always. */
  grantId?: string;
  /** The keys of the grants kept always. */
  granted: ReadonlySet<string>;
}>();
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent/40"
    :style="{ paddingLeft: `${0.5 + depth * 1.25}rem` }"
  >
    <span class="min-w-0 flex-1 truncate">
      <span class="font-mono">{{ label }}</span>
      <span class="ml-1.5 text-muted-foreground">{{ kind }}</span>
    </span>
    <span
      v-for="action in MCP_ACTIONS"
      :key="action"
      class="flex w-24 items-center gap-1"
      :title="actions.includes(action) ? `${action}: ${rules[action].level}, from ${rules[action].from}` : undefined"
    >
      <template v-if="actions.includes(action)">
        <span class="text-muted-foreground">{{ action }}</span>
        <Badge :class="LEVELS[rules[action].level]">
          {{ rules[action].level }}
        </Badge>
        <span
          v-if="grantId && rules[action].level === 'ask' && granted.has(`${action}:${grantId}`)"
          class="text-emerald-600"
          title="Granted always"
        >✓</span>
      </template>
    </span>
  </div>
</template>
