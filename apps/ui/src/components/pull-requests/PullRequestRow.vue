<script setup lang="ts">
import { computed } from "vue";
import { CircleCheck, CircleX, ExternalLink, GitPullRequest, GitPullRequestDraft, LoaderCircle } from "@lucide/vue";
import type { AgentDefinition, PullRequestPayload } from "@appsys/devtool-shared";
import AgentButton from "@/components/agents/AgentButton.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatRelativeDate } from "@/lib/format";

const props = defineProps<{
  pullRequest: PullRequestPayload;
  /** The name of the forge, in the title of its link. */
  forge: string;
}>();

const emit = defineEmits<{
  review: [agent: AgentDefinition];
}>();

const CHECKS = {
  success: { icon: CircleCheck, class: "text-emerald-600", title: "Checks passed" },
  pending: { icon: LoaderCircle, class: "text-amber-500", title: "Checks running" },
  failure: { icon: CircleX, class: "text-destructive", title: "Checks failed" },
} as const;

const REVIEWS = {
  approved: { label: "Approved", class: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  changesRequested: { label: "Changes requested", class: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  required: { label: "Review required", class: "" },
} as const;

const checks = computed(() => (props.pullRequest.checks ? CHECKS[props.pullRequest.checks] : null));
const review = computed(() => (props.pullRequest.review ? REVIEWS[props.pullRequest.review] : null));
</script>

<template>
  <div class="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-start gap-3 border-t px-4 py-2.5 transition-colors hover:bg-accent/30">
    <component
      :is="pullRequest.draft ? GitPullRequestDraft : GitPullRequest"
      class="mt-0.5 size-4"
      :class="pullRequest.draft ? 'text-muted-foreground' : 'text-emerald-600'"
      :title="pullRequest.draft ? 'Draft' : 'Open'"
    />
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-1.5">
        <a
          :href="pullRequest.url"
          target="_blank"
          rel="noopener"
          class="text-sm font-medium hover:underline"
        >{{ pullRequest.title }}</a>
        <Badge
          v-if="pullRequest.reviewRequested"
          class="border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400"
        >
          Your review requested
        </Badge>
        <Badge
          v-if="review"
          variant="outline"
          :class="review.class"
        >
          {{ review.label }}
        </Badge>
      </div>
      <div class="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span>#{{ pullRequest.number }}</span>
        <span v-if="pullRequest.author">{{ pullRequest.author }}</span>
        <span class="truncate font-mono">{{ pullRequest.branch }} → {{ pullRequest.base }}</span>
        <component
          :is="checks.icon"
          v-if="checks"
          class="size-3.5"
          :class="checks.class"
          :title="checks.title"
        />
        <span>{{ formatRelativeDate(pullRequest.updatedAt) }}</span>
      </div>
    </div>
    <div class="flex items-center gap-1">
      <Button
        as-child
        size="icon"
        variant="ghost"
        class="size-7"
      >
        <a
          :href="pullRequest.url"
          target="_blank"
          rel="noopener"
          :title="`Open on ${forge}`"
        >
          <ExternalLink class="size-3.5" />
        </a>
      </Button>
      <AgentButton
        label="Review"
        @start="emit('review', $event)"
      />
    </div>
  </div>
</template>
