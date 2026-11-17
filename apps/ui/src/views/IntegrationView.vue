<script setup lang="ts">
import { computed } from "vue";
import { Icon } from "@iconify/vue";
import { ExternalLink } from "@lucide/vue";
import SidebarToggle from "@/components/SidebarToggle.vue";
import { Button } from "@/components/ui/button";
import configStore from "@/stores/config";

const props = defineProps<{
  integration: string;
  projectSlug?: string;
  directorySlug?: string;
}>();

const integrations = computed(() => {
  if (props.projectSlug && props.directorySlug) {
    return configStore.getDirectory(props.projectSlug, props.directorySlug)?.directory.integrations ?? [];
  }
  return configStore.integrations.value;
});
const definition = computed(() => integrations.value.find((item) => item.slug === props.integration) ?? null);
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
          as-child
          size="icon"
          variant="ghost"
          class="size-7"
        >
          <a
            :href="definition.url"
            target="_blank"
            rel="noopener"
            title="Open in a new tab"
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
    <iframe
      v-if="definition?.embed"
      :key="definition.url"
      :src="definition.url"
      :title="definition.name"
      class="min-h-0 w-full flex-1 border-0"
    />
    <p
      v-else-if="definition"
      class="p-6 text-sm text-muted-foreground"
    >
      {{ definition.name }} opens in its own tab.
    </p>
  </div>
</template>
