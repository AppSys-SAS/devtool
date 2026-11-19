<script setup lang="ts">
import { computed, shallowRef } from "vue";
import { Icon } from "@iconify/vue";
import type { DirectoryExtra } from "@appsys/devtool-shared";
import CommandInputsForm from "@/components/CommandInputsForm.vue";
import { commandLine, commandName, iconFromMeta, runDirectoryCommand } from "@/lib/directory-commands";
import { cn } from "@/lib/utils";

const props = defineProps<{
  projectSlug: string;
  directorySlug: string;
  command: DirectoryExtra;
}>();

const opened = shallowRef(false);

const description = computed(() => (props.command.script ? props.command.script.summary : commandLine(props.command.args)));

/**
 * Shows or hides the form of a command asking for its inputs in its row, else runs it.
 */
function activate(): void {
  if (props.command.form === "inline") {
    opened.value = !opened.value;
    return;
  }
  runDirectoryCommand(props.projectSlug, props.directorySlug, props.command);
}
</script>

<template>
  <div :class="cn('rounded-md border', opened && 'bg-accent/30')">
    <button
      type="button"
      class="flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/60"
      @click="activate"
    >
      <Icon
        :icon="iconFromMeta(command.meta, command.script ? 'lucide:scroll-text' : undefined)"
        class="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <span class="min-w-0 flex-1">
        <strong class="block truncate">{{ commandName(command) }}</strong>
        <span
          v-if="description"
          :class="cn('block text-xs text-muted-foreground', command.script ? !opened && 'line-clamp-2' : 'truncate')"
        >{{ description }}</span>
      </span>
    </button>
    <div
      v-if="opened"
      class="space-y-2 px-3 pb-3"
    >
      <pre
        v-if="command.script?.usage"
        class="overflow-x-auto rounded bg-muted p-2 font-mono text-[11px] leading-4 whitespace-pre"
      >{{ command.script.usage }}</pre>
      <CommandInputsForm
        :command="command"
        @run="(inputs) => runDirectoryCommand(projectSlug, directorySlug, command, { inputs })"
      />
    </div>
  </div>
</template>
