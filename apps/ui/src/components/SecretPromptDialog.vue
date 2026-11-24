<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { KeyRound } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import secretsStore from '@/stores/secrets'

const request = secretsStore.current
const waiting = computed(() => secretsStore.waiting.value.length)
const value = ref('')

watch(() => request.value?.id, () => {
  value.value = ''
})

/**
 * Sends the secret typed for the request shown, the next one then shown.
 */
function submit (): void {
  if (request.value && value.value !== '') {
    secretsStore.answer(request.value.id, value.value)
  }
}

/**
 * Refuses the request shown, the next one then shown.
 */
function cancel (): void {
  if (request.value) {
    secretsStore.answer(request.value.id, null)
  }
}

/**
 * Refuses the request shown when the dialog is closed with Escape.
 * @param event The key event, prevented so that the dialog closes once the request is answered.
 */
function escape (event: KeyboardEvent): void {
  event.preventDefault()
  cancel()
}
</script>

<template>
  <DialogRoot :open="request !== null">
    <DialogPortal>
      <DialogOverlay class="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50" />
      <DialogContent
        v-if="request"
        class="bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border p-6 shadow-lg sm:max-w-lg"
        @interact-outside.prevent
        @escape-key-down="escape"
      >
        <div class="flex items-start justify-between gap-3">
          <DialogTitle class="flex items-center gap-2 text-lg font-semibold">
            <KeyRound class="size-5 text-muted-foreground" />
            Secret needed
          </DialogTitle>
          <span
            v-if="waiting > 1"
            class="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
          >1 / {{ waiting }}</span>
        </div>
        <DialogDescription class="-mt-2 text-sm text-muted-foreground">
          The devtool needs the secret of <span class="font-medium text-foreground">{{ request.label }}</span>. It is kept in memory only, never written to disk.
        </DialogDescription>
        <form
          class="grid gap-4"
          @submit.prevent="submit"
        >
          <Input
            v-model="value"
            type="password"
            autocomplete="off"
            autofocus
          />
          <div class="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              @click="cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              :disabled="value === ''"
            >
              Unlock
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
