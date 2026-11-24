<script setup lang="ts">
import { computed } from 'vue'
import DOMPurify from 'dompurify'
import MarkdownIt, { type StateCore } from 'markdown-it'
import { splitFrontMatter } from '@appsys/devtool-shared'

const props = defineProps<{
  /** The Markdown text, its HTML kept once sanitized, its task lists shown as checkboxes, its alerts as callouts and its YAML front matter left out. */
  source: string
}>()

/** The titles of the alerts, by their marker. */
const ALERTS: Record<string, string> = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' }

/**
 * Turns the quotes starting with an alert marker such as `[!NOTE]` into callouts with their title.
 * @param state The parsed document.
 */
function alerts (state: StateCore): void {
  for (let index = 0; index < state.tokens.length; index += 1) {
    const token = state.tokens[index]
    const inline = state.tokens[index + 2]
    const first = token.type === 'blockquote_open' && inline?.type === 'inline' ? inline.children?.[0] : undefined
    const alert = first?.type === 'text' ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(first.content) : null
    if (!inline || !first || !alert) {
      continue
    }
    const type = alert[1].toUpperCase()
    first.content = first.content.slice(alert[0].length)
    if (!first.content && inline.children?.[1]?.type === 'softbreak') {
      inline.children.splice(0, 2)
    }
    token.attrJoin('class', `markdown-alert markdown-alert-${type.toLowerCase()}`)
    const title = new state.Token('html_block', '', 0)
    title.content = `<p class="markdown-alert-title">${ALERTS[type]}</p>\n`
    state.tokens.splice(index + 1, 0, title)
  }
}

/**
 * Turns the items of a list starting with `[ ]` or `[x]` into read-only checkboxes.
 * @param state The parsed document.
 */
function taskLists (state: StateCore): void {
  state.tokens.forEach((token, index) => {
    const first = token.type === 'inline' ? token.children?.[0] : undefined
    const task = first?.type === 'text' ? /^\[([ xX])\] /.exec(first.content) : null
    const item = state.tokens[index - 2]
    if (!first || !task || item?.type !== 'list_item_open') {
      return
    }
    first.content = first.content.slice(task[0].length)
    const checkbox = new state.Token('html_inline', '', 0)
    checkbox.content = `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> `
    token.children?.unshift(checkbox)
    item.attrJoin('class', 'task-list-item')
  })
}

const markdown = new MarkdownIt({ html: true, linkify: true })
markdown.core.ruler.after('inline', 'task-lists', taskLists)
markdown.core.ruler.after('inline', 'alerts', alerts)
const purify = DOMPurify(window)
purify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

const rendered = computed(() => purify.sanitize(markdown.render(splitFrontMatter(props.source).body)))
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
.markdown-preview :deep(blockquote.markdown-alert) {
  border-left-color: var(--alert, #4493f8);
  color: inherit;
}
.markdown-preview :deep(.markdown-alert-title) {
  margin: 0 0 0.25em;
  color: var(--alert, #4493f8);
  font-weight: 600;
}
.markdown-preview :deep(.markdown-alert-tip) {
  --alert: #3fb950;
}
.markdown-preview :deep(.markdown-alert-important) {
  --alert: #ab7df8;
}
.markdown-preview :deep(.markdown-alert-warning) {
  --alert: #d29922;
}
.markdown-preview :deep(.markdown-alert-caution) {
  --alert: #f85149;
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
.markdown-preview :deep(img) {
  max-width: 100%;
}
.markdown-preview :deep(details) {
  margin: 0.5em 0;
}
.markdown-preview :deep(summary) {
  cursor: pointer;
}
.markdown-preview :deep(li.task-list-item) {
  list-style: none;
  margin-left: -1.25em;
}
.markdown-preview :deep(li.task-list-item input) {
  margin-right: 0.4em;
  vertical-align: middle;
}
</style>
