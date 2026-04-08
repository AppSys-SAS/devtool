<script setup lang="ts">
import StreamView from "@/views/StreamView.vue";

defineProps<{
  projectSlug: string;
  directorySlug: string;
  streamSlug: string;
}>();
</script>

<template>
  <StreamView
    :project-slug="projectSlug"
    :directory-slug="directorySlug"
    :stream-slug="streamSlug"
    :key="streamSlug"
  />
</template>
