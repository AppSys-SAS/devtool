<script setup lang="ts">
import { computed, ref } from "vue";
import { Icon } from "@iconify/vue";
import { useLocalStorage } from "@vueuse/core";
import { ChevronDown, Sparkles } from "@lucide/vue";
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from "reka-ui";
import type { AgentDefinition } from "@appsys/devtool-shared";
import AgentChooserDialog from "@/components/agents/AgentChooserDialog.vue";
import AgentOption from "@/components/agents/AgentOption.vue";
import { Button } from "@/components/ui/button";
import configStore from "@/stores/config";

defineProps<{
  /** The text of the button. */
  label: string;
}>();

const emit = defineEmits<{
  start: [agent: AgentDefinition];
}>();

const lastSlug = useLocalStorage<string | null>("devtool-last-agent", null);
const agents = computed(() => configStore.agents.value);
const last = computed(() => agents.value.find((agent) => agent.slug === lastSlug.value) ?? null);
const choosing = ref(false);

/**
 * Starts an agent, which becomes the one of the button.
 * @param agent The agent.
 */
function start(agent: AgentDefinition): void {
  lastSlug.value = agent.slug;
  emit("start", agent);
}

/**
 * Starts the agent used last, or asks which one when none is known.
 */
function startLast(): void {
  if (last.value) {
    start(last.value);
  } else {
    choosing.value = true;
  }
}
</script>

<template>
  <div
    v-if="agents.length"
    class="flex shrink-0"
  >
    <Button
      size="sm"
      variant="outline"
      class="h-7 gap-1.5 rounded-r-none px-2 text-xs"
      :title="last ? `${label} with ${last.name}` : `${label} with an agent`"
      @click="startLast"
    >
      <Icon
        v-if="last"
        :icon="last.icon"
        class="size-3.5"
      />
      <Sparkles
        v-else
        class="size-3.5"
      />
      {{ label }}
    </Button>
    <DropdownMenuRoot>
      <DropdownMenuTrigger
        as-child
        title="Choose the agent"
      >
        <Button
          size="sm"
          variant="outline"
          class="h-7 rounded-l-none border-l-0 px-1.5"
        >
          <ChevronDown class="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent
          align="end"
          :side-offset="4"
          class="z-50 min-w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <DropdownMenuItem
            v-for="agent in agents"
            :key="agent.slug"
            class="flex cursor-pointer rounded-sm px-2 py-1.5 outline-none data-[highlighted]:bg-accent"
            @select="start(agent)"
          >
            <AgentOption :agent="agent" />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
    <AgentChooserDialog
      v-model:open="choosing"
      :agents="agents"
      @choose="start"
    />
  </div>
</template>
