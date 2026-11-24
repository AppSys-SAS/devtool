<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { Icon } from '@iconify/vue'
import { Play, RotateCcw, Square, Trash2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { CommandStream } from '@/types'

const props = defineProps<{
  stream: CommandStream
  route: RouteLocationRaw
  label: string
  icon?: string
}>()

const emit = defineEmits<{
  start: [slug: string]
  stop: [slug: string]
  restart: [slug: string]
  close: [slug: string]
}>()

const isRunning = computed(() => props.stream.status === 'RUNNING')
</script>

<template>
  <RouterLink
    :to="route"
    class="group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent/60"
    :class="{
      'bg-accent/60': isRunning,
      'border border-destructive/40': stream.status === 'ERROR',
      'border border-valid/40': stream.status === 'STOPPED'
    }"
  >
    <span
      v-if="stream.unread"
      class="pointer-events-none absolute -right-0.5 -top-0.5 z-10"
    >
      <span class="relative flex size-3">
        <span
          class="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75"
        />
        <span class="relative inline-flex size-3 rounded-full bg-sky-500" />
      </span>
    </span>
    <Icon
      :icon="icon ?? 'ph:terminal'"
      class="size-3.5 shrink-0 text-muted-foreground"
    />
    <span class="min-w-0 flex-1 truncate">{{ label }}</span>
    <Badge
      v-if="stream.origin"
      variant="outline"
      class="px-1 py-0 text-[10px] text-muted-foreground"
      :title="`Started by ${stream.origin}`"
    >
      agent
    </Badge>
    <div class="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
      <Button
        v-if="!isRunning"
        size="icon"
        variant="ghost"
        class="size-6"
        @click.prevent.stop="emit('close', stream.slug)"
      >
        <Trash2 class="size-3.5" />
      </Button>
      <Button
        v-if="!isRunning"
        size="icon"
        variant="ghost"
        class="size-6"
        @click.prevent.stop="emit('start', stream.slug)"
      >
        <Play class="size-3.5" />
      </Button>
      <Button
        v-if="isRunning"
        size="icon"
        variant="ghost"
        class="size-6"
        @click.prevent.stop="emit('stop', stream.slug)"
      >
        <Square class="size-3.5" />
      </Button>
      <Button
        v-if="isRunning"
        size="icon"
        variant="ghost"
        class="size-6"
        @click.prevent.stop="emit('restart', stream.slug)"
      >
        <RotateCcw class="size-3.5" />
      </Button>
    </div>
  </RouterLink>
</template>
