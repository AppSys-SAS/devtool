<script setup lang="ts">
import { computed } from "vue";
import { Icon } from "@iconify/vue";
import StreamView from "@/views/StreamView.vue";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import configStore from "@/stores/config";
import { startDefaultCommand } from "@/lib/directory-commands";
import { defaultShortcut } from "@/lib/shortcuts";

const props = defineProps<{
  projectSlug: string;
  directorySlug: string;
}>();

const directoryDefinition = computed(() => configStore.getDirectory(props.projectSlug, props.directorySlug));
const directory = computed(() => directoryDefinition.value?.directory ?? null);
const directoryName = computed(() => directory.value?.name ?? props.directorySlug);
const directoryDescription = computed(() => directory.value?.description ?? null);
const directoryArgs = computed(() => directory.value?.args ?? null);
const directoryShell = computed(() => directory.value?.shell ?? "N/A");
const defaultAction = computed(() => (directory.value ? defaultShortcut(props.projectSlug, directory.value) : null));
const streamSlug = computed(() => configStore.getDirectoryStreamPrimary(props.projectSlug, props.directorySlug));
</script>

<template>
  <StreamView
    v-if="streamSlug"
    :project-slug="projectSlug"
    :directory-slug="directorySlug"
    :stream-slug="streamSlug"
    :key="streamSlug"
  />
  <div
    v-else
    class="flex h-full items-center justify-center p-6"
  >
    <Card class="w-full max-w-xl">
      <CardHeader>
        <CardTitle>{{ directoryName }}</CardTitle>
      </CardHeader>
      <CardContent class="space-y-4">
        <p
          v-if="directoryDescription"
          class="text-sm text-muted-foreground"
        >
          {{ directoryDescription }}
        </p>
        <Button
          v-if="directoryArgs"
          class="h-auto w-full justify-start whitespace-normal break-all px-3 py-2 text-left font-mono text-xs leading-5"
          @click="directory && startDefaultCommand(projectSlug, directory)"
        >
          {{ directoryArgs.join(" ") || directoryShell }}
        </Button>
        <Button
          v-if="defaultAction && directory?.defaultAction?.shortcut.type !== 'command'"
          variant="outline"
          class="w-full justify-start"
          @click="defaultAction.open()"
        >
          <Icon
            :icon="defaultAction.icon"
            class="size-4"
          />
          {{ defaultAction.name }}
        </Button>
      </CardContent>
    </Card>
  </div>
</template>
