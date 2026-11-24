<script setup lang="ts">
import { computed } from "vue";
import { Icon } from "@iconify/vue";
import IntegrationLink from "@/components/IntegrationLink.vue";
import DirectorySummaryCard from "@/components/project/DirectorySummaryCard.vue";
import { iconFromMeta } from "@/lib/directory-commands";
import configStore from "@/stores/config";

const props = defineProps<{
  projectSlug: string;
}>();

const project = computed(() => configStore.getProject(props.projectSlug));
const directories = computed(() => {
  const value = project.value;
  return (value?.content ?? []).flatMap((key) => value?.directories[key] ?? []).filter((directory) => !directory.missing);
});
const running = computed(
  () => configStore.commandStreams.value.filter((stream) => stream.projectSlug === props.projectSlug && stream.status === "RUNNING").length,
);
</script>

<template>
  <div
    v-if="project"
    class="h-full overflow-auto p-6"
  >
    <header class="mb-6 space-y-1">
      <div class="flex items-center gap-2">
        <Icon
          :icon="iconFromMeta(project.meta, 'lucide:folder-tree')"
          class="size-5 text-muted-foreground"
        />
        <h1 class="text-xl font-semibold">
          {{ project.name }}
        </h1>
        <span class="ml-2 text-sm text-muted-foreground">
          {{ directories.length }} sub-project{{ directories.length > 1 ? "s" : "" }}<template v-if="running"> · {{ running }} running</template>
        </span>
      </div>
      <p
        v-if="project.description"
        class="text-sm text-muted-foreground"
      >
        {{ project.description }}
      </p>
      <p class="font-mono text-xs break-all text-muted-foreground/70">
        {{ project.path }}
      </p>
    </header>

    <div
      v-if="project.integrations.length"
      class="mb-6 grid gap-2 sm:grid-cols-2 xl:grid-cols-3"
    >
      <IntegrationLink
        v-for="integration in project.integrations"
        :key="integration.slug"
        :integration="integration"
        :project-slug="projectSlug"
      />
    </div>

    <div class="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
      <DirectorySummaryCard
        v-for="directory in directories"
        :key="directory.slug"
        :project-slug="projectSlug"
        :directory="directory"
      />
    </div>
  </div>
</template>
