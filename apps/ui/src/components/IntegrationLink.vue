<script setup lang="ts">
import { Icon } from "@iconify/vue";
import { RouterLink } from "vue-router";
import type { IntegrationDefinition } from "@appsys/devtool-shared";
import { hasIntegrationPage, integrationRoute } from "@/lib/shortcuts";

defineProps<{
  integration: IntegrationDefinition;
  /** The project declaring it, or holding the directory declaring it, if any. */
  projectSlug?: string;
  /** The directory declaring it, if any. */
  directorySlug?: string;
}>();
</script>

<template>
  <component
    :is="hasIntegrationPage(integration) ? RouterLink : 'a'"
    v-bind="hasIntegrationPage(integration) ? { to: integrationRoute(integration, projectSlug, directorySlug) } : { href: integration.url, target: '_blank', rel: 'noopener' }"
    class="flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent/60"
  >
    <Icon
      :icon="integration.icon"
      class="mt-0.5 size-4 shrink-0"
    />
    <span class="min-w-0 flex-1">
      <strong class="block truncate">{{ integration.name }}</strong>
      <span class="block truncate text-xs text-muted-foreground">{{ integration.url }}</span>
    </span>
  </component>
</template>
