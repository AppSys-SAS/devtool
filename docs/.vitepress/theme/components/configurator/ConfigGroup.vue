<script setup lang="ts">
defineProps<{
  title: string
  description?: string
  open?: boolean
}>()
</script>

<template>
  <details class="config-group" :open="open">
    <summary>
      <span class="title">{{ title }}</span>
      <span v-if="description" class="description">{{ description }}</span>
    </summary>
    <div class="body">
      <slot />
    </div>
  </details>
</template>

<style scoped>
.config-group {
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
}

summary {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 16px;
  cursor: pointer;
  list-style: none;
}

summary::-webkit-details-marker {
  display: none;
}

.title {
  font-family: var(--vp-font-family-heading);
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.title::before {
  content: '▸ ';
  color: var(--vp-c-brand-1);
}

.config-group[open] .title::before {
  content: '▾ ';
}

.description {
  font-size: 13px;
  color: var(--vp-c-text-2);
}

.body {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
  padding: 4px 16px 16px;
}
</style>
