<script setup lang="ts">
import { computed } from 'vue'
import { useConfigurator } from './useConfigurator'
import type { ConfigPath } from './useConfigurator'

const props = defineProps<{
  path: ConfigPath
  label: string
  placeholder?: string
}>()

const store = useConfigurator()
const args = computed(() => store.get(props.path))
const hasInputs = computed(() => Array.isArray(args.value) && args.value.some(arg => typeof arg === 'object'))

const text = computed({
  get: () => Array.isArray(args.value) ? args.value.map(quote).join(' ') : '',
  set: (next: string) => {
    store.set(props.path, split(next))
  }
})

/**
 * Quotes an argument holding spaces or quotes so it reads back as one word.
 * @param arg The argument.
 * @returns The argument as typed in a shell.
 */
function quote (arg: unknown): string {
  const word = String(arg)
  return /[\s"']/.test(word) || word === '' ? `'${word.replaceAll('\'', '\'"\'"\'')}'` : word
}

/**
 * Splits a command line into words like a shell, honouring single and double quotes.
 * @param line The command line.
 * @returns The words.
 */
function split (line: string): string[] {
  const words: string[] = []
  let word: string | null = null
  let quoteChar: string | null = null
  for (const char of line) {
    if (quoteChar) {
      if (char === quoteChar) {
        quoteChar = null
      } else {
        word = (word ?? '') + char
      }
    } else if (char === '"' || char === '\'') {
      quoteChar = char
      word ??= ''
    } else if (/\s/.test(char)) {
      if (word !== null) {
        words.push(word)
      }
      word = null
    } else {
      word = (word ?? '') + char
    }
  }
  if (word !== null) {
    words.push(word)
  }
  return words
}
</script>

<template>
  <label class="args-field">
    <span class="label">{{ label }}</span>
    <code v-if="hasInputs" class="locked">Holds inputs: edit it in your YAML file.</code>
    <input
      v-else
      v-model.lazy="text"
      type="text"
      :placeholder="placeholder"
      spellcheck="false"
    >
  </label>
</template>

<style scoped>
.args-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  grid-column: 1 / -1;
}

.label {
  font-size: 13px;
  font-weight: 600;
}

input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
}

input:focus {
  outline: 2px solid var(--vp-c-brand-soft);
  border-color: var(--vp-c-brand-1);
}

.locked {
  font-size: 12px;
}
</style>
