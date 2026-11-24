<script setup lang="ts">
import { computed } from 'vue'
import { useConfigurator } from './useConfigurator'
import type { ConfigPath } from './useConfigurator'

const props = defineProps<{
  path: ConfigPath
  addLabel: string
  newItem: () => Record<string, unknown>
}>()

defineSlots<{
  default: (scope: { path: ConfigPath }) => unknown
}>()

const store = useConfigurator()
const items = computed(() => {
  const value = store.get(props.path)
  return Array.isArray(value) ? value : []
})

/**
 * Appends a new item to the list.
 */
function addItem (): void {
  store.set(props.path, [...items.value, props.newItem()])
}
</script>

<template>
  <div class="item-list">
    <div v-for="(item, index) in items" :key="index" class="item">
      <template v-if="typeof item === 'object' && item !== null">
        <slot :path="[...path, index]" />
      </template>
      <code v-else class="short">{{ item }}</code>
      <button type="button" class="remove" @click="store.remove([...path, index])">
        Remove
      </button>
    </div>
    <button type="button" class="add" @click="addItem">
      + {{ addLabel }}
    </button>
  </div>
</template>

<style scoped>
.item-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  grid-column: 1 / -1;
}

.item {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  align-items: end;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg);
}

.short {
  align-self: center;
}

.remove {
  justify-self: end;
  padding: 2px 10px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-2);
}

.remove:hover {
  color: #e24e4d;
}

.add {
  align-self: flex-start;
  padding: 6px 14px;
  border: 1px dashed var(--vp-c-brand-1);
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
}

.add:hover {
  background: var(--vp-c-brand-soft);
}
</style>
