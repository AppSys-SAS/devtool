<script setup lang="ts">
import StreamView from "@/views/StreamView.vue";

defineProps<{
  projectSlug: string;
  streamSlug: string;
}>();
</script>

<template>
  <StreamView
    :project-slug="projectSlug"
    :stream-slug="streamSlug"
    :key="streamSlug"
  />
</template>
