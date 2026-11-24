<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { TabsList, TabsRoot, TabsTrigger } from "reka-ui";
import type { AgentDefinition, DirectoryDefinition, IntegrationDefinition, PullRequestPayload } from "@appsys/devtool-shared";
import { DEFAULT_REVIEW_PROMPT, pullRequestPrompt } from "@appsys/devtool-shared";
import PullRequestRow from "@/components/pull-requests/PullRequestRow.vue";
import { startAgent } from "@/lib/agents";
import { formatRelativeDate } from "@/lib/format";
import configStore from "@/stores/config";
import pullRequestsStore from "@/stores/pull-requests";

const props = defineProps<{
  integration: IntegrationDefinition;
  projectSlug: string;
  directory: DirectoryDefinition;
}>();

const FILTERS = {
  open: { label: "Open", keep: () => true },
  review: { label: "Review requested", keep: (pullRequest: PullRequestPayload) => pullRequest.reviewRequested },
  mine: { label: "Mine", keep: (pullRequest: PullRequestPayload) => pullRequest.mine },
} as const;
type Filter = keyof typeof FILTERS;

const route = useRoute();
const router = useRouter();
const tab = computed<Filter>({
  get: () => (typeof route.query.tab === "string" && route.query.tab in FILTERS ? (route.query.tab as Filter) : "open"),
  set: (value) => void router.replace({ query: { ...route.query, tab: value } }),
});

const state = computed(() => pullRequestsStore.get(`${props.projectSlug}/${props.directory.slug}/${props.integration.slug}`));
const items = computed(() => state.value?.items ?? []);
const tabs = computed(() => (Object.entries(FILTERS) as [Filter, (typeof FILTERS)[Filter]][]).map(([value, filter]) => ({ value, label: filter.label, count: items.value.filter(filter.keep).length })));
const shown = computed(() => items.value.filter(FILTERS[tab.value].keep));

/**
 * Starts the review of a pull request by an agent.
 * @param pullRequest The pull request.
 * @param agent The agent.
 */
function review(pullRequest: PullRequestPayload, agent: AgentDefinition): void {
  const prompt = pullRequestPrompt(props.integration.prompt ?? DEFAULT_REVIEW_PROMPT, pullRequest);
  startAgent(agent, props.projectSlug, props.directory, prompt, `Review #${pullRequest.number}`);
}
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
        <template v-if="state?.loading">Reading…</template>
        <template v-else-if="state?.updatedAt">Read {{ formatRelativeDate(state.updatedAt) }}</template>
      </span>
    </TabsRoot>
    <p
      v-if="state?.error"
      class="mx-4 mt-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
    >
      {{ state.error }}
    </p>
    <p
      v-if="!configStore.agents.value.length"
      class="mx-4 mt-3 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
    >
      Declare agents in <code>adt.agents</code> to review a pull request with one.
    </p>
    <div class="mt-2">
      <PullRequestRow
        v-for="pullRequest in shown"
        :key="pullRequest.number"
        :pull-request="pullRequest"
        :forge="integration.provider?.label ?? 'the forge'"
        @review="review(pullRequest, $event)"
      />
      <p
        v-if="!shown.length && state?.updatedAt"
        class="border-t px-4 py-6 text-center text-sm text-muted-foreground"
      >
        No pull request here.
      </p>
    </div>
  </div>
</template>
