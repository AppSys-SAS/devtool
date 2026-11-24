<script setup lang="ts">
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import type { AgentDefinition } from '@appsys/devtool-shared'
import AgentOption from '@/components/agents/AgentOption.vue'
import { buttonVariants } from '@/components/ui/button'

defineProps<{
  agents: AgentDefinition[]
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  choose: [agent: AgentDefinition]
}>()

/**
 * Picks an agent and closes the dialog.
 * @param agent The agent picked.
 */
function choose (agent: AgentDefinition): void {
  open.value = false
  emit('choose', agent)
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50" />
      <DialogContent
        class="bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border p-6 shadow-lg sm:max-w-md"
      >
        <DialogTitle class="text-lg font-semibold">
          Choose an agent
        </DialogTitle>
        <DialogDescription class="text-sm text-muted-foreground">
          The agent chosen is started again by the button next time; its arrow lists them all.
        </DialogDescription>
        <div class="space-y-1">
          <button
            v-for="agent in agents"
            :key="agent.slug"
            type="button"
            class="flex w-full rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent/60"
            @click="choose(agent)"
          >
            <AgentOption :agent="agent" />
          </button>
        </div>
        <div class="flex justify-end">
          <DialogClose :class="buttonVariants({ variant: 'outline' })">
            Cancel
          </DialogClose>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
