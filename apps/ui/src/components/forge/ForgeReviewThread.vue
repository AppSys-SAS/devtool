<script setup lang="ts">
import { computed } from "vue";
import type { ForgeReviewThread } from "@appsys/devtool-shared";
import MarkdownPreview from "@/components/files/MarkdownPreview.vue";
import { Badge } from "@/components/ui/badge";
import { formatRelativeDate } from "@/lib/format";

const props = defineProps<{
  thread: ForgeReviewThread;
}>();

/** How many lines of the change end the excerpt shown above a discussion. */
const EXCERPT_LINES = 4;

const excerpt = computed(() =>
  (props.thread.diffHunk ?? "")
    .split("\n")
    .filter((line) => !line.startsWith("@@"))
    .slice(-EXCERPT_LINES)
    .map((line) => ({ text: line, class: line.startsWith("+") ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : line.startsWith("-") ? "bg-red-500/15 text-red-700 dark:text-red-300" : "" })),
);
</script>

<template>
  <details
    class="group rounded-md border"
    :open="!thread.resolved"
  >
    <summary class="flex cursor-pointer items-center gap-2 bg-muted/40 px-3 py-1 text-[11px]">
      <code class="min-w-0 truncate">{{ thread.path }}<template v-if="thread.line">:{{ thread.line }}</template></code>
      <Badge
        v-if="thread.outdated"
        variant="outline"
        class="text-[10px] text-muted-foreground"
      >
        Outdated
      </Badge>
      <Badge
        v-if="thread.resolved"
        variant="outline"
        class="border-transparent bg-emerald-500/15 text-[10px] text-emerald-700 dark:text-emerald-400"
      >
        Resolved
      </Badge>
      <span class="ml-auto text-muted-foreground">{{ thread.comments.length }} comment{{ thread.comments.length > 1 ? "s" : "" }}</span>
    </summary>
    <pre
      v-if="excerpt.length"
      class="overflow-x-auto border-t text-[11px] leading-5"
    ><code
      v-for="(line, index) in excerpt"
      :key="index"
      class="block px-3"
      :class="line.class"
    >{{ line.text || " " }}</code></pre>
    <div
      v-for="(comment, index) in thread.comments"
      :key="index"
      class="border-t"
    >
      <div class="flex items-center gap-2 px-3 pt-2 text-xs text-muted-foreground">
        <span class="font-medium text-foreground">{{ comment.author ?? "Someone" }}</span>
        <span>{{ formatRelativeDate(comment.createdAt) }}</span>
      </div>
      <MarkdownPreview :source="comment.body" />
    </div>
  </details>
</template>
