<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ArrowLeft } from '@lucide/vue'
import type { ForgeItemsPayload, IntegrationDefinition } from '@appsys/devtool-shared'
import { forgeEntries, integrationKey } from '@appsys/devtool-shared'
import MarkdownPreview from '@/components/files/MarkdownPreview.vue'
import ForgeItemActions from '@/components/forge/ForgeItemActions.vue'
import ForgeItemSummary from '@/components/forge/ForgeItemSummary.vue'
import ForgeTimeline from '@/components/forge/ForgeTimeline.vue'
import { Button } from '@/components/ui/button'
import type { AgentPlace } from '@/lib/agents'
import { FORGE_ICONS, startForgeAction } from '@/lib/forge'
import { integrationRoute } from '@/lib/shortcuts'
import forgeItemsStore from '@/stores/forge-items'
import wsStore from '@/stores/ws'

const props = defineProps<{
  integration: IntegrationDefinition
  /** The section or project declaring the integration, where the agents work. */
  place: AgentPlace
  /** The items, as last read. */
  state: ForgeItemsPayload
  /** The number of the item shown. */
  number: number
}>()

const entry = computed(() => forgeEntries(props.state).find(item => item.item.number === props.number) ?? null)
const key = computed(() => integrationKey(props.place.projectSlug, props.place.directorySlug, props.integration.slug))
const timeline = computed(() => forgeItemsStore.timelineOf(key.value, props.number))
const listRoute = computed(() => integrationRoute(props.integration, props.place.projectSlug, props.place.directorySlug ?? undefined))
const loadingPrevious = ref(false)

watch(
  [key, () => props.number],
  ([integration, number]) => wsStore.forgeTimelineRead(integration, number),
  { immediate: true }
)
watch(timeline, () => {
  loadingPrevious.value = false
})

/**
 * Asks for the events of the timeline before those shown.
 */
function loadPrevious (): void {
  if (timeline.value?.before) {
    loadingPrevious.value = true
    wsStore.forgeTimelineRead(key.value, props.number, timeline.value.before)
  }
}
</script>

<template>
  <div class="min-h-0 flex-1 overflow-auto">
    <div class="mx-auto max-w-4xl space-y-4 p-4">
      <Button
        as-child
        size="sm"
        variant="ghost"
        class="gap-1.5"
      >
        <RouterLink :to="listRoute">
          <ArrowLeft class="size-3.5" />
          {{ integration.name }}
        </RouterLink>
      </Button>
      <p
        v-if="!entry"
        class="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
      >
        #{{ number }} is not among the open items read last.
      </p>
      <template v-else>
        <header class="flex items-start gap-3">
          <component
            :is="FORGE_ICONS[entry.kind]"
            class="mt-1 size-5 shrink-0 text-emerald-600"
          />
          <div class="min-w-0 flex-1 space-y-1.5">
            <h1 class="text-lg font-semibold leading-snug">
              {{ entry.item.title }}
            </h1>
            <ForgeItemSummary :entry="entry" />
          </div>
          <ForgeItemActions
            :url="entry.item.url"
            :forge="integration.provider?.label ?? 'the forge'"
            :actions="integration.agentActions"
            @start="(action, agent) => entry && startForgeAction(integration, place, entry, action, agent)"
          />
        </header>
        <section class="rounded-lg border">
          <MarkdownPreview
            v-if="entry.item.body.trim()"
            :source="entry.item.body"
          />
          <p
            v-else
            class="px-6 py-4 text-sm text-muted-foreground"
          >
            No description.
          </p>
        </section>
        <section class="space-y-3">
          <h2 class="text-sm font-semibold">
            Timeline
          </h2>
          <p
            v-if="!timeline"
            class="text-sm text-muted-foreground"
          >
            Reading…
          </p>
          <p
            v-else-if="timeline.error"
            class="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {{ timeline.error }}
          </p>
          <p
            v-else-if="!timeline.events.length && !timeline.before"
            class="text-sm text-muted-foreground"
          >
            Nothing happened yet.
          </p>
          <ForgeTimeline
            v-else
            :events="timeline.events"
            :remaining="timeline.before ? timeline.remaining : 0"
            :loading="loadingPrevious"
            @load-previous="loadPrevious"
          />
        </section>
      </template>
    </div>
  </div>
</template>
