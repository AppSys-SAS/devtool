<script setup lang="ts">
import { computed, useTemplateRef, watchEffect } from 'vue'
import { Icon } from '@iconify/vue'
import { ExternalLink, RotateCw } from '@lucide/vue'
import { integrationKey } from '@appsys-sas/devtool-shared'
import ForgeItemDetail from '@/components/forge/ForgeItemDetail.vue'
import ForgeItemList from '@/components/forge/ForgeItemList.vue'
import SidebarToggle from '@/components/SidebarToggle.vue'
import { Button } from '@/components/ui/button'
import type { AgentPlace } from '@/lib/agents'
import configStore from '@/stores/config'
import embedStore from '@/stores/embeds'
import forgeItemsStore from '@/stores/forge-items'
import wsStore from '@/stores/ws'

const props = defineProps<{
  integration: string
  projectSlug?: string
  directorySlug?: string
  /** The number of the pull request or issue shown, none for the list. */
  number?: string
}>()

const place = computed<AgentPlace | null>(() => {
  const section = props.projectSlug ? configStore.projects.value?.[props.projectSlug] : undefined
  if (!section) {
    return null
  }
  if (!props.directorySlug) {
    return { projectSlug: section.slug, directorySlug: null, path: section.path }
  }
  const directory = section.directories[props.directorySlug]
  return directory ? { projectSlug: section.slug, directorySlug: directory.slug, path: directory.path } : null
})
const integrations = computed(() => {
  if (!props.projectSlug) {
    return configStore.integrations.value
  }
  const section = configStore.projects.value?.[props.projectSlug]
  return (props.directorySlug ? section?.directories[props.directorySlug]?.integrations : section?.integrations) ?? []
})
const definition = computed(() => integrations.value.find(item => item.slug === props.integration) ?? null)
const forgeKey = computed(() => (definition.value && definition.value.type !== 'web' && place.value ? integrationKey(place.value.projectSlug, place.value.directorySlug, props.integration) : null))
const forgeState = computed(() => (forgeKey.value ? forgeItemsStore.get(forgeKey.value) : null))
const frameArea = useTemplateRef<HTMLElement>('frameArea')

watchEffect(onCleanup => {
  const element = frameArea.value
  const integration = definition.value
  if (!element || !integration?.embed) {
    return
  }
  embedStore.show({ url: integration.url, title: integration.name }, element)
  onCleanup(() => embedStore.hide(element))
})
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
          v-if="forgeKey"
          size="icon"
          variant="ghost"
          class="size-7"
          title="Read them again"
          :disabled="forgeState?.loading"
          @click="wsStore.forgeItemsRefresh(forgeKey)"
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
    <template v-if="definition && forgeState && place">
      <ForgeItemDetail
        v-if="number"
        :integration="definition"
        :place="place"
        :state="forgeState"
        :number="Number(number)"
      />
      <ForgeItemList
        v-else
        :integration="definition"
        :place="place"
        :state="forgeState"
      />
    </template>
    <div
      v-else-if="definition?.embed"
      ref="frameArea"
      class="min-h-0 flex-1"
    />
    <p
      v-else-if="definition?.type === 'web'"
      class="p-6 text-sm text-muted-foreground"
    >
      {{ definition.name }} opens in its own tab.
    </p>
  </div>
</template>
