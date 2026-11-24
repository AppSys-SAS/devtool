<script setup lang="ts">
import { computed, useTemplateRef, watchEffect } from "vue";
import { Icon } from "@iconify/vue";
import { ExternalLink, RotateCw } from "@lucide/vue";
import PullRequestList from "@/components/pull-requests/PullRequestList.vue";
import SidebarToggle from "@/components/SidebarToggle.vue";
import { Button } from "@/components/ui/button";
import configStore from "@/stores/config";
import embedStore from "@/stores/embeds";
import pullRequestsStore from "@/stores/pull-requests";
import wsStore from "@/stores/ws";

const props = defineProps<{
  integration: string;
  projectSlug?: string;
  directorySlug?: string;
}>();

const directory = computed(() => (props.projectSlug && props.directorySlug ? (configStore.getDirectory(props.projectSlug, props.directorySlug)?.directory ?? null) : null));
const integrations = computed(() => (props.projectSlug && props.directorySlug ? (directory.value?.integrations ?? []) : configStore.integrations.value));
const definition = computed(() => integrations.value.find((item) => item.slug === props.integration) ?? null);
const pullRequestsKey = computed(() => (definition.value?.type === "pullRequests" ? `${props.projectSlug}/${props.directorySlug}/${props.integration}` : null));
const frameArea = useTemplateRef<HTMLElement>("frameArea");

watchEffect((onCleanup) => {
  const element = frameArea.value;
  const integration = definition.value;
  if (!element || !integration?.embed) {
    return;
  }
  embedStore.show({ url: integration.url, title: integration.name }, element);
  onCleanup(() => embedStore.hide(element));
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-2 border-b px-2 py-1.5">
      <SidebarToggle side="left" />
      <template v-if="definition">
        <Icon
          :icon="definition.icon"
          class="size-4 shrink-0"
        />
        <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ definition.name }}</span>
        <Button
          v-if="definition.embed"
          size="icon"
          variant="ghost"
          class="size-7"
          title="Reload"
          @click="embedStore.reload(definition.url)"
        >
          <RotateCw class="size-3.5" />
        </Button>
        <Button
          v-if="pullRequestsKey"
          size="icon"
          variant="ghost"
          class="size-7"
          title="Read the pull requests again"
          :disabled="pullRequestsStore.get(pullRequestsKey)?.loading"
          @click="wsStore.pullRequestsRefresh(pullRequestsKey)"
        >
          <RotateCw class="size-3.5" />
        </Button>
        <Button
          as-child
          size="icon"
          variant="ghost"
          class="size-7"
        >
          <a
            :href="definition.url"
            target="_blank"
            rel="noopener"
            :title="definition.provider ? `Open on ${definition.provider.label}` : 'Open in a new tab'"
          >
            <ExternalLink class="size-3.5" />
          </a>
        </Button>
      </template>
      <span
        v-else
        class="min-w-0 flex-1 truncate text-sm text-muted-foreground"
      >No integration {{ integration }}.</span>
      <SidebarToggle side="right" />
    </div>
    <PullRequestList
      v-if="definition && pullRequestsKey && directory && projectSlug"
      :integration="definition"
      :project-slug="projectSlug"
      :directory="directory"
    />
    <div
      v-else-if="definition?.embed"
      ref="frameArea"
      class="min-h-0 flex-1"
    />
    <p
      v-else-if="definition"
      class="p-6 text-sm text-muted-foreground"
    >
      {{ definition.name }} opens in its own tab.
    </p>
  </div>
</template>
