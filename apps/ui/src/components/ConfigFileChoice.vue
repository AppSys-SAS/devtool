<script setup lang="ts">
import { cn } from '@/lib/utils'
import { shortPath } from '@/lib/mcp'

defineProps<{
  /** The personal override, null when the server loads none. */
  localFile: string | null
  /** What a shared change writes to. */
  sharedHint: string
}>()

const file = defineModel<'local' | 'declared'>({ required: true })
</script>

<template>
  <div class="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-3 py-2 text-xs">
    <span class="text-muted-foreground">Write changes to</span>
    <div class="flex rounded-md border bg-background p-0.5">
      <button
        v-for="option in [
          { file: 'local' as const, label: 'Personal', hint: localFile ? shortPath(localFile) : 'no personal override loaded' },
          { file: 'declared' as const, label: 'Shared', hint: 'the file declaring each setting' },
        ]"
        :key="option.file"
        type="button"
        :disabled="option.file === 'local' && !localFile"
        :class="cn(
          'rounded px-2.5 py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          file === option.file ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
        )"
        :title="option.hint"
        @click="file = option.file"
      >
        {{ option.label }}
      </button>
    </div>
    <span class="text-muted-foreground">
      <template v-if="file === 'local'">
        <code>{{ localFile ? shortPath(localFile) : "" }}</code>, loaded last: it prevails over every other file, for you only.
      </template>
      <template v-else>
        {{ sharedHint }}
      </template>
    </span>
  </div>
</template>
