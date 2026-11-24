<script setup lang="ts">
import { type Component, computed } from "vue";
import { Circle, CircleX, Eye, FilePen, GitCommitHorizontal, GitMerge, Link, LoaderCircle, Pencil, RotateCcw, Tag, Upload, UserPlus } from "@lucide/vue";
import type { ForgeEventKind, ForgeReviewState, ForgeTimelineEvent } from "@appsys/devtool-shared";
import MarkdownPreview from "@/components/files/MarkdownPreview.vue";
import ForgeReviewThread from "@/components/forge/ForgeReviewThread.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatRelativeDate } from "@/lib/format";

const props = defineProps<{
  /** What happened, the oldest first. */
  events: ForgeTimelineEvent[];
  /** About how many events come before these, 0 when there is none. */
  remaining: number;
  /** Whether the events before these are being read. */
  loading: boolean;
}>();

const emit = defineEmits<{
  loadPrevious: [];
}>();

type Commit = Extract<ForgeTimelineEvent, { type: "commit" }>;

/** An entry of the timeline: an event, or commits pushed one after the other, the most recent first. */
type Entry = { key: string; event: Exclude<ForgeTimelineEvent, Commit>; commits?: undefined } | { key: string; event?: undefined; commits: Commit[] };

const EVENT_ICONS: Record<ForgeEventKind, Component> = {
  label: Tag,
  assign: UserPlus,
  reviewRequest: Eye,
  merge: GitMerge,
  close: CircleX,
  reopen: RotateCcw,
  push: Upload,
  rename: Pencil,
  reference: Link,
  draft: FilePen,
  other: Circle,
};

const REVIEWS: Record<ForgeReviewState, { label: string; class: string }> = {
  approved: { label: "approved", class: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  changesRequested: { label: "requested changes", class: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  commented: { label: "reviewed", class: "" },
  dismissed: { label: "review dismissed", class: "text-muted-foreground" },
};

const entries = computed(() =>
  [...props.events].reverse().reduce<Entry[]>((list, event, index) => {
    const last = list.at(-1);
    if (event.type !== "commit") {
      list.push({ key: `${props.events.length - index}`, event });
    } else if (last?.commits) {
      last.commits.push(event);
    } else {
      list.push({ key: `${props.events.length - index}`, commits: [event] });
    }
    return list;
  }, []),
);
</script>

<template>
  <div class="space-y-3">
    <ol class="relative space-y-3 border-l pl-5">
      <li
        v-for="entry in entries"
        :key="entry.key"
      >
        <div
          v-if="entry.commits"
          class="space-y-1 text-xs text-muted-foreground"
        >
          <div class="flex items-center gap-1.5">
            <GitCommitHorizontal class="size-3.5" />
            {{ entry.commits.length }} commit{{ entry.commits.length > 1 ? "s" : "" }}
          </div>
          <ul class="space-y-0.5 pl-5">
            <li
              v-for="commit in entry.commits"
              :key="commit.sha"
              class="flex min-w-0 items-baseline gap-2"
            >
              <code class="shrink-0 text-[11px]">{{ commit.sha }}</code>
              <span class="min-w-0 truncate text-foreground">{{ commit.message }}</span>
              <span
                v-if="commit.author"
                class="shrink-0"
              >{{ commit.author }}</span>
            </li>
          </ul>
        </div>
        <article
          v-else-if="entry.event.type === 'comment' || entry.event.type === 'review'"
          class="rounded-lg border"
        >
          <div class="flex items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
            <span class="font-medium text-foreground">{{ entry.event.author ?? "Someone" }}</span>
            <Badge
              v-if="entry.event.type === 'review'"
              variant="outline"
              :class="REVIEWS[entry.event.state].class"
            >
              {{ REVIEWS[entry.event.state].label }}
            </Badge>
            <span>{{ formatRelativeDate(entry.event.createdAt) }}</span>
          </div>
          <MarkdownPreview
            v-if="entry.event.body.trim()"
            :source="entry.event.body"
          />
          <div
            v-if="entry.event.type === 'review' && entry.event.threads.length"
            class="space-y-2 border-t px-4 py-3"
          >
            <ForgeReviewThread
              v-for="(thread, index) in entry.event.threads"
              :key="index"
              :thread="thread"
            />
          </div>
        </article>
        <div
          v-else
          class="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
        >
          <component
            :is="EVENT_ICONS[entry.event.kind]"
            class="size-3.5"
          />
          <span class="font-medium text-foreground">{{ entry.event.author ?? "Someone" }}</span>
          <span>{{ entry.event.text }}</span>
          <Badge
            v-if="entry.event.label"
            variant="outline"
            class="gap-1"
          >
            <span
              class="size-2 rounded-full"
              :style="{ backgroundColor: entry.event.label.color ?? 'currentColor' }"
            />
            {{ entry.event.label.name }}
          </Badge>
          <span>{{ formatRelativeDate(entry.event.createdAt) }}</span>
        </div>
      </li>
    </ol>
    <Button
      v-if="remaining"
      variant="outline"
      size="sm"
      class="gap-2"
      :disabled="loading"
      @click="emit('loadPrevious')"
    >
      <LoaderCircle
        v-if="loading"
        class="size-3.5 animate-spin"
      />
      Load previous events
      <span class="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{{ remaining }}</span>
    </Button>
  </div>
</template>
