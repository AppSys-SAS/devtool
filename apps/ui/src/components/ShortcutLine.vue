<script setup lang="ts">
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import { useRoute, useRouter } from 'vue-router'
import type { SidebarShortcut } from '@/lib/shortcuts'

const props = defineProps<{
  shortcut: SidebarShortcut
  /** Shows only the icon, for a shortcut placed in another row. */
  compact?: boolean
}>()

const COUNT_CLASS = 'rounded-full bg-sky-500/20 px-1.5 text-[10px] leading-4 font-semibold tabular-nums text-sky-700 dark:text-sky-300'

const route = useRoute()
const router = useRouter()
const active = computed(() => props.shortcut.route !== null && router.resolve(props.shortcut.route).fullPath === route.fullPath)
</script>

<template>
  <button
    v-if="compact"
    type="button"
    class="group flex h-5 min-w-5 shrink-0 items-center justify-center gap-1 rounded"
    :title="shortcut.count ? `${shortcut.name}: ${shortcut.count}` : shortcut.name"
    @click.prevent.stop="shortcut.open()"
  >
    <Icon
      :icon="shortcut.icon"
      class="size-3.5 transition"
      :class="active ? '' : 'opacity-50 grayscale group-hover:opacity-100 group-hover:grayscale-0'"
    />
    <span
      v-if="shortcut.count"
      :class="COUNT_CLASS"
    >{{ shortcut.count }}</span>
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
    <span
      v-if="shortcut.count"
      :class="COUNT_CLASS"
    >{{ shortcut.count }}</span>
  </button>
</template>
