<script setup lang="ts">
import { computed } from "vue";
import MarkdownIt from "markdown-it";
import { splitFrontMatter } from "@appsys/devtool-shared";

const props = defineProps<{
  /** The Markdown text, its HTML shown as text and its YAML front matter left out. */
  source: string;
}>();

const markdown = new MarkdownIt({ html: false, linkify: true });

const rendered = computed(() => markdown.render(splitFrontMatter(props.source).body));
</script>

<template>
  <div
    class="markdown-preview overflow-auto px-6 py-4 text-sm"
    v-html="rendered"
  />
</template>

<style scoped>
.markdown-preview :deep(:is(h1, h2, h3, h4)) {
  margin: 1.25em 0 0.5em;
  font-weight: 600;
  line-height: 1.3;
}
.markdown-preview :deep(h1) {
  font-size: 1.5em;
}
.markdown-preview :deep(h2) {
  font-size: 1.25em;
}
.markdown-preview :deep(h3) {
  font-size: 1.1em;
}
.markdown-preview :deep(:is(p, ul, ol, pre, table, blockquote)) {
  margin: 0.75em 0;
}
.markdown-preview :deep(:is(ul, ol)) {
  padding-left: 1.5em;
}
.markdown-preview :deep(ul) {
  list-style: disc;
}
.markdown-preview :deep(ol) {
  list-style: decimal;
}
.markdown-preview :deep(a) {
  text-decoration: underline;
}
.markdown-preview :deep(code) {
  border-radius: 0.25rem;
  background: var(--muted);
  padding: 0.1em 0.3em;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.9em;
}
.markdown-preview :deep(pre) {
  overflow-x: auto;
  border-radius: 0.375rem;
  background: var(--muted);
  padding: 0.75em 1em;
}
.markdown-preview :deep(pre code) {
  background: none;
  padding: 0;
}
.markdown-preview :deep(blockquote) {
  border-left: 3px solid var(--border);
  padding-left: 1em;
  color: var(--muted-foreground);
}
.markdown-preview :deep(:is(th, td)) {
  border: 1px solid var(--border);
  padding: 0.25em 0.5em;
}
.markdown-preview :deep(hr) {
  margin: 1em 0;
  border-color: var(--border);
}
.markdown-preview :deep(> :first-child) {
  margin-top: 0;
}
</style>
