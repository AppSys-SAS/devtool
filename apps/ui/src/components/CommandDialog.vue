<script setup lang="ts">
import { computed, nextTick, shallowRef, useTemplateRef, watch } from 'vue'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { CircleCheck, CircleX, Loader2, Send, Square } from '@lucide/vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { pendingPrompt, terminalText } from '@/lib/command-prompt'
import { STREAM_STATUS } from '@/stores/command-stream'
import configStore from '@/stores/config'
import wsStore from '@/stores/ws'

const props = defineProps<{
  tag: string
  title: string
}>()

const emit = defineEmits<{
  finished: []
  closed: []
}>()

const outputElement = useTemplateRef<HTMLPreElement>('output')
const answer = shallowRef('')

const stream = computed(() => configStore.commandStreams.value.find(item => item.tag === props.tag) ?? null)
const running = computed(() => stream.value?.status === STREAM_STATUS.RUNNING)
const text = computed(() => {
  const output = stream.value ? (configStore.getCommandStreamsOutput(stream.value.slug)?.output ?? []) : []
  return terminalText(output.map(line => (line.type === 'info' ? `\n${line.content}\n` : line.content))).replace(/^\n+/, '')
})
const prompt = computed(() => (running.value ? pendingPrompt(text.value) : null))

watch(running, (isRunning, wasRunning) => {
  if (wasRunning && !isRunning) {
    emit('finished')
  }
})

watch(text, async () => {
  await nextTick()
  outputElement.value?.scrollTo({ top: outputElement.value.scrollHeight })
})

/**
 * Answers the question of the command.
 * @param value The answer, sent with a line break.
 */
function send (value: string): void {
  if (stream.value) {
    wsStore.streamInput(stream.value.slug, `${value}\r`)
  }
  answer.value = ''
}

/**
 * Closes the dialog, forgetting the command once it is finished; a running command goes on.
 */
function close (): void {
  if (stream.value && !running.value) {
    wsStore.updateCommandStream(stream.value.slug, 'close')
  }
  emit('closed')
}
</script>

<template>
  <DialogRoot
    :open="true"
    @update:open="(open) => !open && close()"
  >
    <DialogPortal>
      <DialogOverlay class="data-[state=open]:animate-in data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50" />
      <DialogContent
        class="bg-background data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border p-6 shadow-lg sm:max-w-2xl"
        @interact-outside="(event) => event.preventDefault()"
      >
        <div class="flex items-center gap-3">
          <DialogTitle class="min-w-0 flex-1 truncate text-lg font-semibold">
            {{ title }}
          </DialogTitle>
          <Badge
            v-if="running || !stream"
            variant="outline"
            class="gap-1.5"
          >
            <Loader2 class="size-3 animate-spin" />
            Running
          </Badge>
          <Badge
            v-else-if="(stream.exitCode ?? 0) === 0"
            variant="outline"
            class="gap-1.5 border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
          >
            <CircleCheck class="size-3" />
            Done
          </Badge>
          <Badge
            v-else
            variant="outline"
            class="gap-1.5 border-destructive/40 text-destructive"
          >
            <CircleX class="size-3" />
            Failed ({{ stream.exitCode }})
          </Badge>
        </div>
        <DialogDescription class="sr-only">
          Output of the command and the questions it asks.
        </DialogDescription>

        <pre
          ref="output"
          class="max-h-80 min-h-32 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words"
        >{{ text }}</pre>

        <div
          v-if="prompt"
          class="space-y-2 rounded-md border p-3"
        >
          <p class="font-mono text-sm">
            {{ prompt.text }}
          </p>
          <div
            v-if="prompt.choice"
            class="flex gap-2"
          >
            <Button
              size="sm"
              :variant="prompt.choice.defaultAnswer === 'yes' ? 'default' : 'outline'"
              @click="send(prompt.choice.yes)"
            >
              Yes
            </Button>
            <Button
              size="sm"
              :variant="prompt.choice.defaultAnswer === 'no' ? 'default' : 'outline'"
              @click="send(prompt.choice.no)"
            >
              No
            </Button>
          </div>
          <form
            v-else
            class="flex gap-2"
            @submit.prevent="send(answer)"
          >
            <Input
              v-model="answer"
              :type="prompt.secret ? 'password' : 'text'"
              class="h-8 font-mono text-sm"
              autofocus
            />
            <Button
              type="submit"
              size="sm"
              class="h-8"
            >
              <Send class="size-3.5" />
              Send
            </Button>
          </form>
        </div>

        <div class="flex justify-end gap-2">
          <Button
            v-if="running && stream"
            variant="outline"
            @click="wsStore.updateCommandStream(stream.slug, 'stop')"
          >
            <Square class="size-4" />
            Stop
          </Button>
          <Button
            :variant="running ? 'outline' : 'default'"
            @click="close"
          >
            {{ running ? "Run in background" : "Close" }}
          </Button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
