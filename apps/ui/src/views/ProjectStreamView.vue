<script setup lang="ts">
import StreamView from '@/views/StreamView.vue'

defineProps<{
  projectSlug: string
  streamSlug: string
}>()
</script>

<template>
  <StreamView
    :key="streamSlug"
    :project-slug="projectSlug"
    :stream-slug="streamSlug"
  />
</template>
