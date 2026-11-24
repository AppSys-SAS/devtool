<script setup lang="ts">
import { computed } from "vue";
import { CircleCheck, CircleX, LoaderCircle, MessageSquare } from "@lucide/vue";
import type { ForgeEntry } from "@appsys/devtool-shared";
import { Badge } from "@/components/ui/badge";
import { formatRelativeDate } from "@/lib/format";

const props = defineProps<{
  entry: ForgeEntry;
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

const WAITING_CLASS = "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400";

const pullRequest = computed(() => (props.entry.kind === "pullRequests" ? props.entry.item : null));
const issue = computed(() => (props.entry.kind === "issues" ? props.entry.item : null));
const checks = computed(() => (pullRequest.value?.checks ? CHECKS[pullRequest.value.checks] : null));
const review = computed(() => (pullRequest.value?.review ? REVIEWS[pullRequest.value.review] : null));
</script>

<template>
  <div class="space-y-1">
    <div
      v-if="pullRequest?.reviewRequested || review || issue?.assigned || entry.item.labels.length"
      class="flex flex-wrap items-center gap-1.5"
    >
      <Badge
        v-if="pullRequest?.reviewRequested"
        :class="WAITING_CLASS"
      >
        Your review requested
      </Badge>
      <Badge
        v-if="issue?.assigned"
        :class="WAITING_CLASS"
      >
        Assigned to you
      </Badge>
      <Badge
        v-if="review"
        variant="outline"
        :class="review.class"
      >
        {{ review.label }}
      </Badge>
      <Badge
        v-for="label in entry.item.labels"
        :key="label.name"
        variant="outline"
        class="gap-1"
      >
        <span
          class="size-2 rounded-full"
          :style="{ backgroundColor: label.color ?? 'currentColor' }"
        />
        {{ label.name }}
      </Badge>
    </div>
    <div class="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
      <span>#{{ entry.item.number }}</span>
      <span v-if="entry.item.author">{{ entry.item.author }}</span>
      <template v-if="pullRequest">
        <span class="truncate font-mono">{{ pullRequest.branch }} → {{ pullRequest.base }}</span>
        <component
          :is="checks.icon"
          v-if="checks"
          class="size-3.5"
          :class="checks.class"
          :title="checks.title"
        />
      </template>
      <template v-if="issue">
        <span v-if="issue.assignees.length">→ {{ issue.assignees.join(", ") }}</span>
        <span
          v-if="issue.comments"
          class="flex items-center gap-0.5"
          :title="`${issue.comments} comments`"
        >
          <MessageSquare class="size-3" />
          {{ issue.comments }}
        </span>
      </template>
      <span>{{ formatRelativeDate(entry.item.updatedAt) }}</span>
    </div>
  </div>
</template>
