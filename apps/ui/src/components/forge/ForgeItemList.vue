<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { TabsList, TabsRoot, TabsTrigger } from 'reka-ui'
import type { ForgeItemsPayload, IntegrationDefinition } from '@appsys-sas/devtool-shared'
import { forgeEntries } from '@appsys-sas/devtool-shared'
import ForgeItemActions from '@/components/forge/ForgeItemActions.vue'
import ForgeItemSummary from '@/components/forge/ForgeItemSummary.vue'
import type { AgentPlace } from '@/lib/agents'
import { FORGE_FILTERS, FORGE_ICONS, forgeItemRoute, startForgeAction } from '@/lib/forge'
import { formatRelativeDate } from '@/lib/format'
import configStore from '@/stores/config'

const props = defineProps<{
  integration: IntegrationDefinition
  /** The section or project declaring the integration, where the agents work. */
  place: AgentPlace
  /** The items, as last read. */
  state: ForgeItemsPayload
}>()

const route = useRoute()
const router = useRouter()
const filters = computed(() => FORGE_FILTERS[props.state.kind])
const tab = computed({
  get: () => filters.value.find(filter => filter.value === route.query.tab)?.value ?? filters.value[0].value,
  set: (value: string) => void router.replace({ query: { ...route.query, tab: value } })
})

const entries = computed(() => forgeEntries(props.state))
const tabs = computed(() => filters.value.map(filter => ({ ...filter, count: entries.value.filter(filter.keep).length })))
const shown = computed(() => entries.value.filter(filters.value.find(filter => filter.value === tab.value)?.keep ?? (() => true)))
</script>

<template>
  <div class="min-h-0 flex-1 overflow-auto">
    <TabsRoot
      v-model="tab"
      class="flex items-center gap-3 px-4 pt-2"
    >
      <TabsList class="flex gap-1">
        <TabsTrigger
          v-for="item in tabs"
          :key="item.value"
          :value="item.value"
          class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-accent data-[state=active]:text-foreground"
        >
          {{ item.label }}
          <span class="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{{ item.count }}</span>
        </TabsTrigger>
      </TabsList>
      <span class="ml-auto text-xs text-muted-foreground">
        <template v-if="state.loading">Reading…</template>
        <template v-else-if="state.updatedAt">Read {{ formatRelativeDate(state.updatedAt) }}</template>
      </span>
    </TabsRoot>
    <p
      v-if="state.error"
      class="mx-4 mt-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
    >
      {{ state.error }}
    </p>
    <p
      v-if="integration.agentActions.length && !configStore.agents.value.length"
      class="mx-4 mt-3 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
    >
      Declare agents in <code>adt.agents</code> to start one from here.
    </p>
    <div class="mt-2">
      <div
        v-for="entry in shown"
        :key="entry.item.number"
        class="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-start gap-3 border-t px-4 py-2.5 transition-colors hover:bg-accent/30"
      >
        <component
          :is="FORGE_ICONS[entry.kind]"
          class="mt-0.5 size-4"
          :class="entry.kind === 'pullRequests' && entry.item.draft ? 'text-muted-foreground' : 'text-emerald-600'"
        />
        <div class="min-w-0 space-y-0.5">
          <RouterLink
            :to="forgeItemRoute(place, integration.slug, entry.item.number)"
            class="text-sm font-medium hover:underline"
          >
            <span
              v-if="entry.kind === 'pullRequests' && entry.item.draft"
              class="text-muted-foreground"
            >Draft: </span>{{ entry.item.title }}
          </RouterLink>
          <ForgeItemSummary :entry="entry" />
        </div>
        <ForgeItemActions
          :url="entry.item.url"
          :forge="integration.provider?.label ?? 'the forge'"
          :actions="integration.agentActions"
          @start="(action, agent) => startForgeAction(integration, place, entry, action, agent)"
        />
      </div>
      <p
        v-if="!shown.length && state.updatedAt"
        class="border-t px-4 py-6 text-center text-sm text-muted-foreground"
      >
        Nothing here.
      </p>
    </div>
  </div>
</template>
