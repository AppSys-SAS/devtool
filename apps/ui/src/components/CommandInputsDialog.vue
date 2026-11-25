<script setup lang="ts">
import { computed } from 'vue'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import type { CommandInputValue } from '@appsys-sas/devtool-shared'
import CommandInputsForm from '@/components/CommandInputsForm.vue'
import { commandName } from '@/lib/directory-commands'
import commandInputsStore from '@/stores/command-inputs'

const request = commandInputsStore.current

const open = computed({
  get: () => request.value !== null,
  set: value => {
    if (!value) {
      commandInputsStore.close()
    }
  }
})

/**
 * Runs the command with the values typed.
 * @param inputs The values of its inputs.
 */
function submit (inputs: CommandInputValue[]): void {
  commandInputsStore.submit(inputs)
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50" />
      <DialogContent
        v-if="request"
        class="bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border p-6 shadow-lg sm:max-w-lg"
      >
        <DialogTitle class="text-lg font-semibold">
          {{ commandName(request.command) }}
        </DialogTitle>
        <DialogDescription
          v-if="request.command.script?.summary"
          class="text-sm text-muted-foreground"
        >
          {{ request.command.script.summary }}
        </DialogDescription>
        <CommandInputsForm
          :key="request.id"
          :command="request.command"
          @run="submit"
        />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
