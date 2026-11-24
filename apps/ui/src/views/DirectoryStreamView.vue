<script setup lang="ts">
import StreamView from '@/views/StreamView.vue'

defineProps<{
  projectSlug: string
  directorySlug: string
  streamSlug: string
}>()
</script>

<template>
  <StreamView
    :key="streamSlug"
    :project-slug="projectSlug"
    :directory-slug="directorySlug"
    :stream-slug="streamSlug"
  />
</template>
