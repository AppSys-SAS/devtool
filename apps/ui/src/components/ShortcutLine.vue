<script setup lang="ts">
import { computed } from "vue";
import { Icon } from "@iconify/vue";
import { useRoute, useRouter } from "vue-router";
import type { SidebarShortcut } from "@/lib/shortcuts";

const props = defineProps<{
  shortcut: SidebarShortcut;
  /** Shows only the icon, for a shortcut placed in another row. */
  compact?: boolean;
}>();

const route = useRoute();
const router = useRouter();
const active = computed(() => props.shortcut.route !== null && router.resolve(props.shortcut.route).fullPath === route.fullPath);
</script>

<template>
  <button
    v-if="compact"
    type="button"
    class="flex size-5 shrink-0 items-center justify-center rounded transition"
    :class="active ? '' : 'opacity-50 grayscale hover:opacity-100 hover:grayscale-0'"
    :title="shortcut.name"
    @click.prevent.stop="shortcut.open()"
  >
    <Icon
      :icon="shortcut.icon"
      class="size-3.5"
    />
  </button>
  <button
    v-else
    type="button"
    class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60"
    :class="{ 'bg-accent': active }"
    @click="shortcut.open()"
  >
    <Icon
      :icon="shortcut.icon"
      class="size-3.5 shrink-0 text-muted-foreground"
    />
    <span class="min-w-0 flex-1 truncate">{{ shortcut.name }}</span>
  </button>
</template>
