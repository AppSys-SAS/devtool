<script setup lang="ts">
import { computed, type HTMLAttributes } from 'vue'
import { Icon } from '@iconify/vue'
import { Check, ChevronDown } from '@lucide/vue'
import {
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport
} from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<{
  options: { label: string, value: string, icon?: string }[]
  placeholder?: string
  class?: HTMLAttributes['class']
}>()

const model = defineModel<string>()
const selected = computed(() => props.options.find(option => option.value === model.value))
</script>

<template>
  <SelectRoot v-model="model">
    <SelectTrigger
      data-slot="select-trigger"
      :class="cn(
        'border-input dark:bg-input/30 dark:hover:bg-input/50 data-[placeholder]:text-muted-foreground flex h-8 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 text-xs shadow-xs outline-none transition-[color,box-shadow]',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        props.class,
      )"
    >
      <SelectValue
        :placeholder="placeholder"
        class="flex min-w-0 items-center gap-2"
      >
        <Icon
          v-if="selected?.icon"
          :icon="selected.icon"
          class="size-3.5 shrink-0"
        />
        <span class="truncate">{{ selected?.label }}</span>
      </SelectValue>
      <SelectIcon as-child>
        <ChevronDown class="size-3.5 shrink-0 opacity-50" />
      </SelectIcon>
    </SelectTrigger>
    <SelectPortal>
      <SelectContent
        data-slot="select-content"
        position="popper"
        :side-offset="4"
        class="bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 relative z-50 max-h-(--reka-select-content-available-height) min-w-(--reka-select-trigger-width) overflow-y-auto rounded-md border p-1 shadow-md"
      >
        <SelectViewport>
          <SelectItem
            v-for="option in options"
            :key="option.value"
            :value="option.value"
            class="focus:bg-accent focus:text-accent-foreground relative flex w-full cursor-default items-center rounded-sm py-1.5 pr-8 pl-2 text-xs outline-none select-none"
          >
            <Icon
              v-if="option.icon"
              :icon="option.icon"
              class="mr-2 size-3.5 shrink-0"
            />
            <SelectItemText>{{ option.label }}</SelectItemText>
            <SelectItemIndicator class="absolute right-2 flex items-center">
              <Check class="size-3.5" />
            </SelectItemIndicator>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
