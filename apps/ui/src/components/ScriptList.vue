<script setup lang="ts">
import { shallowRef } from "vue";
import { ScrollText } from "@lucide/vue";
import type { DirectoryDefinition, ScriptPayload } from "@appsys/devtool-shared";
import ScriptArgumentsForm from "@/components/ScriptArgumentsForm.vue";
import { useDirectoryScripts } from "@/composables/useDirectoryScripts";
import { cn } from "@/lib/utils";
import commandRunsStore from "@/stores/command-runs";
import wsStore from "@/stores/ws";

const props = defineProps<{
  projectSlug: string;
  directory: DirectoryDefinition;
}>();

const opened = shallowRef<string | null>(null);

const payload = useDirectoryScripts(() => props.projectSlug, () => props.directory);

/**
 * Shows or hides the arguments of a script.
 * @param script The script.
 */
function toggle(script: ScriptPayload): void {
  opened.value = opened.value === script.path ? null : script.path;
}

/**
 * Runs a script, in the background with its questions in a dialog, or in a terminal.
 * @param script The script.
 * @param scriptArgs Its arguments.
 */
function run(script: ScriptPayload, scriptArgs: string[]): void {
  const command = {
    projectSlug: props.projectSlug,
    directorySlug: props.directory.slug,
    args: [script.path, ...scriptArgs],
    env: props.directory.env,
    killSignal: props.directory.killSignal,
    notifications: props.directory.notifications,
    name: [script.name, ...scriptArgs].join(" "),
  };
  if (script.prompt) {
    commandRunsStore.start(command);
    return;
  }

  wsStore.newCommandStream(command.projectSlug, command.directorySlug, false, command.args, command.env, command.killSignal, command.notifications, command.name, { redirect: true });
}
</script>

<template>
  <div class="space-y-1">
    <p
      v-if="payload?.error"
      class="text-xs text-destructive"
    >
      {{ payload.error }}
    </p>
    <div
      v-for="script in payload?.scripts ?? []"
      :key="script.path"
      :class="cn('rounded-md border', opened === script.path && 'bg-accent/30')"
    >
      <button
        type="button"
        class="flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/60"
        @click="toggle(script)"
      >
        <ScrollText class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1">
          <strong class="block truncate">{{ script.name }}</strong>
          <span
            v-if="script.summary"
            :class="cn('block text-xs text-muted-foreground', opened !== script.path && 'line-clamp-2')"
          >{{ script.summary }}</span>
        </span>
      </button>
      <div
        v-if="opened === script.path"
        class="space-y-2 px-3 pb-3"
      >
        <pre
          v-if="script.usage"
          class="overflow-x-auto rounded bg-muted p-2 font-mono text-[11px] leading-4 whitespace-pre"
        >{{ script.usage }}</pre>
        <ScriptArgumentsForm
          :script="script"
          @run="(scriptArgs) => run(script, scriptArgs)"
        />
      </div>
    </div>
  </div>
</template>
