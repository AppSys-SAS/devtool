<script setup lang="ts">
import { computed } from "vue";
import { MCP_ACTIONS, mcpLevelsFor, type McpAction, type McpLevel, type McpRules, type McpTarget } from "@appsys/devtool-shared";
import McpLevelSelect from "@/components/mcp/McpLevelSelect.vue";
import { Badge } from "@/components/ui/badge";
import { LEVELS, shortPath, type McpEditMode } from "@/lib/mcp";
import mcpStore from "@/stores/mcp";

const props = defineProps<{
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
  /** Where the setting of the row is written, absent when it cannot be changed. */
  target?: McpTarget;
  /** The levels of a setting being a level itself, every action of the row changing it; absent for an `mcp` setting. */
  levels?: readonly McpLevel[];
  /** Where changes are written while the page is in edit mode, null outside of it. */
  edit: McpEditMode | null;
}>();

const file = computed(() => (props.edit?.file === "local" ? props.edit.localFile : props.target?.declaredIn) ?? null);
const blocked = computed(() => {
  if (!props.target) {
    return "Declared by the devtool itself";
  }
  return file.value ? null : props.edit?.file === "local" ? "No personal override is loaded" : "Declared in the personal override only";
});

/**
 * Writes a new level of an action of the row.
 * @param action The action.
 * @param level The level, null to inherit it.
 */
function change(action: McpAction, level: McpLevel | null): void {
  if (props.target && props.edit) {
    mcpStore.setLevel(props.target.path, props.levels ? null : action, level, props.edit.file);
  }
}
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent/40"
    :style="{ paddingLeft: `${0.5 + depth * 1.25}rem` }"
  >
    <span
      class="min-w-0 flex-1 truncate"
      :title="`${label} ${kind}`"
    >
      <span class="font-mono">{{ label }}</span>
      <span class="ml-1.5 text-muted-foreground">{{ kind }}</span>
      <span
        v-if="edit?.file === 'declared' && file"
        class="ml-1.5 font-mono text-[10px] text-sky-700 dark:text-sky-300"
        :title="file"
      >→ {{ shortPath(file) }}</span>
    </span>
    <span
      v-for="action in MCP_ACTIONS"
      :key="action"
      class="flex w-24 items-center gap-1"
      :title="actions.includes(action) && !edit ? `${action}: ${rules[action].level}, from ${rules[action].from}` : undefined"
    >
      <template v-if="actions.includes(action)">
        <span class="text-muted-foreground">{{ action }}</span>
        <McpLevelSelect
          v-if="edit"
          :rule="rules[action]"
          :levels="levels ?? mcpLevelsFor(action)"
          :blocked="blocked"
          @select="(level) => change(action, level)"
        />
        <Badge
          v-else
          :class="LEVELS[rules[action].level]"
        >
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
