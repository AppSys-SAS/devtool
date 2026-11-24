<script setup lang="ts">
import { computed } from 'vue'
import { asRecord } from './configFiles'
import { useConfigurator } from './useConfigurator'
import type { ConfigPath } from './useConfigurator'

const props = defineProps<{
  path: ConfigPath
  base: string
  addLabel: string
  newEntry: () => Record<string, unknown>
}>()

defineSlots<{
  default: (scope: { slug: string, path: ConfigPath }) => unknown
}>()

const store = useConfigurator()
const slugs = computed(() => Object.keys(asRecord(store.get(props.path))))

/**
 * Renames an entry from the value of its slug field.
 * @param slug The current slug.
 * @param event The change event of the field.
 */
function onRename (slug: string, event: Event): void {
  const input = event.target as HTMLInputElement
  store.rename(props.path, slug, input.value)
  if (!slugs.value.includes(input.value.trim())) {
    input.value = slug
  }
}
</script>

<template>
  <div class="entry-list">
    <div v-for="slug in slugs" :key="slug" class="entry">
      <div class="entry-head">
        <input
          class="slug"
          :value="slug"
          aria-label="Slug"
          spellcheck="false"
          @change="onRename(slug, $event)"
        >
        <button
          type="button"
          class="remove"
          :title="`Remove ${slug}`"
          @click="store.remove([...path, slug])"
        >
          Remove
        </button>
      </div>
      <div class="entry-body">
        <slot :slug="slug" :path="[...path, slug]" />
      </div>
    </div>
    <button type="button" class="add" @click="store.add(path, base, newEntry())">
      + {{ addLabel }}
    </button>
  </div>
</template>

<style scoped>
.entry-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  grid-column: 1 / -1;
}

.entry {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg);
}

.entry-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vp-c-divider);
}

.slug {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  font-size: 14px;
  font-weight: 600;
}

.slug:hover,
.slug:focus {
  border-color: var(--vp-c-divider);
}

.entry-body {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
  padding: 12px;
}

.remove,
.add {
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  transition: background-color 0.2s, color 0.2s;
}

.remove {
  padding: 2px 10px;
  color: var(--vp-c-text-2);
}

.remove:hover {
  color: #e24e4d;
}

.add {
  align-self: flex-start;
  padding: 6px 14px;
  border: 1px dashed var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}

.add:hover {
  background: var(--vp-c-brand-soft);
}
</style>
