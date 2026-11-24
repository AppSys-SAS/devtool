<script setup lang="ts">
import { computed } from 'vue'
import { useConfigurator } from './useConfigurator'
import type { ConfigPath } from './useConfigurator'

const props = withDefaults(defineProps<{
  path: ConfigPath
  label: string
  type?: 'text' | 'number' | 'checkbox' | 'select' | 'list'
  options?: readonly string[]
  placeholder?: string
  hint?: string
  defaultValue?: string | number | boolean
}>(), { type: 'text', options: () => [], placeholder: undefined, hint: undefined, defaultValue: undefined })

const store = useConfigurator()

const fallback = computed(() => props.type === 'checkbox' ? props.defaultValue ?? false : props.defaultValue)

const value = computed({
  get: () => store.get(props.path) ?? fallback.value,
  set: (next: unknown) => {
    store.set(props.path, next === fallback.value ? undefined : next)
  }
})

const listText = computed({
  get: () => Array.isArray(value.value) ? value.value.join(', ') : '',
  set: (text: string) => {
    value.value = text.split(',').map(item => item.trim()).filter(Boolean)
  }
})

const numberValue = computed({
  get: () => typeof value.value === 'number' ? value.value : '',
  set: (next: number | string) => {
    value.value = next === '' ? undefined : Number(next)
  }
})
</script>

<template>
  <label class="config-field" :class="{ inline: type === 'checkbox' }">
    <input v-if="type === 'checkbox'" v-model="value" type="checkbox">
    <span class="label">{{ label }}</span>
    <span v-if="type === 'select'" class="select">
      <select v-model="value">
        <option :value="undefined">-</option>
        <option v-for="option in options" :key="option" :value="option">{{ option }}</option>
      </select>
    </span>
    <input
      v-else-if="type === 'number'"
      v-model="numberValue"
      type="number"
      :placeholder="placeholder"
    >
    <input
      v-else-if="type === 'list'"
      v-model.lazy="listText"
      type="text"
      :placeholder="placeholder"
    >
    <input
      v-else-if="type !== 'checkbox'"
      v-model.lazy="value"
      type="text"
      :placeholder="placeholder"
    >
    <small v-if="hint" class="hint">{{ hint }}</small>
  </label>
</template>

<style scoped>
.config-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.config-field.inline {
  flex-direction: row;
  align-self: start;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  height: 58px;
  padding-top: 24px;
}

.label {
  font-size: 13px;
  line-height: 20px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.hint {
  font-size: 12px;
  color: var(--vp-c-text-2);
}

input[type='text'],
input[type='number'],
select {
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  padding: 6px 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 14px;
}

input[type='text']:focus,
input[type='number']:focus,
select:focus {
  outline: 2px solid var(--vp-c-brand-soft);
  border-color: var(--vp-c-brand-1);
}

.select {
  position: relative;
  display: block;
}

.select select {
  appearance: none;
  padding-right: 32px;
  cursor: pointer;
}

.select::after {
  content: '';
  position: absolute;
  top: 50%;
  right: 13px;
  width: 7px;
  height: 7px;
  border-right: 2px solid var(--vp-c-text-2);
  border-bottom: 2px solid var(--vp-c-text-2);
  transform: translateY(-70%) rotate(45deg);
  pointer-events: none;
}

input[type='checkbox'] {
  accent-color: var(--vp-c-brand-1);
}
</style>
