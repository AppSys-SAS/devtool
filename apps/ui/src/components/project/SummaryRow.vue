<script setup lang="ts">
defineProps<{
  label: string;
}>();
</script>

<template>
  <div class="space-y-1.5">
    <p class="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
      {{ label }}
    </p>
    <div class="flex flex-wrap gap-1.5">
      <slot />
    </div>
  </div>
</template>
