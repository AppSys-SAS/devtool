<script setup lang="ts">
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle
} from 'reka-ui'
import { buttonVariants } from '@/components/ui/button'

defineProps<{
  title: string
  confirmLabel: string
  /** Whether the action cannot be confirmed now. */
  disabled?: boolean
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  confirm: []
}>()
</script>

<template>
  <AlertDialogRoot v-model:open="open">
    <AlertDialogPortal>
      <AlertDialogOverlay class="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50" />
      <AlertDialogContent
        class="bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 grid-rows-[auto_minmax(0,1fr)_auto] gap-4 rounded-lg border p-6 shadow-lg sm:max-w-lg"
      >
        <AlertDialogTitle class="text-lg font-semibold">
          {{ title }}
        </AlertDialogTitle>
        <AlertDialogDescription
          as="div"
          class="min-h-0 overflow-y-auto text-sm break-words text-muted-foreground"
        >
          <slot />
        </AlertDialogDescription>
        <div class="flex justify-end gap-2">
          <AlertDialogCancel :class="buttonVariants({ variant: 'outline' })">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            :class="buttonVariants({ variant: 'destructive' })"
            :disabled="disabled"
            @click="emit('confirm')"
          >
            {{ confirmLabel }}
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
