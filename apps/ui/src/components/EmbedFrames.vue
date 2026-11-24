<script setup lang="ts">
import { computed } from "vue";
import { useElementBounding } from "@vueuse/core";
import embedStore from "@/stores/embeds";

const bounds = useElementBounding(computed(() => embedStore.shown.value?.element ?? null));
const style = computed(() => ({
  top: `${bounds.top.value}px`,
  left: `${bounds.left.value}px`,
  width: `${bounds.width.value}px`,
  height: `${bounds.height.value}px`,
}));
</script>

<template>
  <iframe
    v-for="embed in embedStore.embeds.value"
    v-show="embed.url === embedStore.shown.value?.url"
    :key="`${embed.url}#${embed.reloads}`"
    :src="embed.url"
    :title="embed.title"
    :style="style"
    class="fixed border-0"
  />
</template>
