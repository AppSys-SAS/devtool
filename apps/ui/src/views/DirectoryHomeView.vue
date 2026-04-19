<script setup lang="ts">
import { computed } from "vue";
import StreamView from "@/views/StreamView.vue";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import configStore from "@/stores/config";
import wsStore from "@/stores/ws";

const props = defineProps<{
  projectSlug: string;
  directorySlug: string;
}>();

const directoryDefinition = computed(() => configStore.getDirectory(props.projectSlug, props.directorySlug));
const directory = computed(() => directoryDefinition.value?.directory ?? null);
const directoryName = computed(() => directory.value?.name ?? props.directorySlug);
const directoryDescription = computed(() => directory.value?.description ?? null);
const directoryArgs = computed(() => directory.value?.args ?? ["N/A"]);
const directoryShell = computed(() => directory.value?.shell ?? ["N/A"]);
const streamSlug = computed(() => configStore.getDirectoryStreamPrimary(props.projectSlug, props.directorySlug));

function runCommand(): void {
  if (!directory.value) {
    return;
  }

  wsStore.newCommandStream(
    props.projectSlug,
    props.directorySlug,
    true,
    directory.value.args,
    directory.value.env,
    directory.value.killSignal,
    directory.value.notifications,
    directory.value.name,
  );
}
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
          class="h-auto w-full justify-start whitespace-normal break-all px-3 py-2 text-left font-mono text-xs leading-5"
          @click="runCommand"
        >
          {{ directoryArgs.join(" ") || directoryShell }}
        </Button>
      </CardContent>
    </Card>
  </div>
</template>
