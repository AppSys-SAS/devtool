<script setup lang="ts">
import { computed } from 'vue'
import ConfigField from './ConfigField.vue'
import { BACKEND_FIELDS, BACKEND_SHARED_FIELDS } from './configFields'
import { useConfigurator } from './useConfigurator'
import type { ConfigPath } from './useConfigurator'

const props = defineProps<{
  path: ConfigPath
}>()

const store = useConfigurator()
const fields = computed(() => {
  const type = store.get([...props.path, 'type'])
  return [...BACKEND_SHARED_FIELDS, ...(typeof type === 'string' ? BACKEND_FIELDS[type] ?? [] : [])]
})
</script>

<template>
  <ConfigField
    v-for="field in fields"
    :key="field.label"
    v-bind="field"
    :path="[...path, ...field.path]"
  />
</template>
