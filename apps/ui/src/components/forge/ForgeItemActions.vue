<script setup lang="ts">
import { ExternalLink } from "@lucide/vue";
import type { AgentAction, AgentDefinition } from "@appsys/devtool-shared";
import AgentButton from "@/components/agents/AgentButton.vue";
import { Button } from "@/components/ui/button";
import { AGENT_ACTION_VIEWS } from "@/lib/forge";

defineProps<{
  /** The web address of the item on its forge. */
  url: string;
  /** The name of the forge, in the title of its link. */
  forge: string;
  /** What agents may do with the item, in order. */
  actions: AgentAction[];
}>();

const emit = defineEmits<{
  start: [action: AgentAction, agent: AgentDefinition];
}>();
</script>

<template>
  <div class="flex shrink-0 items-center gap-1">
    <Button
      as-child
      size="icon"
      variant="ghost"
      class="size-7"
    >
      <a
        :href="url"
        target="_blank"
        rel="noopener"
        :title="`Open on ${forge}`"
      >
        <ExternalLink class="size-3.5" />
      </a>
    </Button>
    <AgentButton
      v-for="action in actions"
      :key="action"
      :label="AGENT_ACTION_VIEWS[action].label"
      :icon="AGENT_ACTION_VIEWS[action].compact ? AGENT_ACTION_VIEWS[action].icon : undefined"
      @start="emit('start', action, $event)"
    />
  </div>
</template>
