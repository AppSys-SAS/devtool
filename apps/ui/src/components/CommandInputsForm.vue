<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import { MessageSquare, Play, X } from '@lucide/vue'
import { commandInputs, defaultCommandInputs, expandCommandArgs, missingCommandInputs, type CommandInput, type CommandInputValue, type DirectoryExtra } from '@appsys/devtool-shared'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { cn } from '@/lib/utils'

const props = defineProps<{
  command: DirectoryExtra
  /** The values the inputs start with, their defaults when absent. */
  initial?: CommandInputValue[] | null
}>()

const emit = defineEmits<{
  run: [inputs: CommandInputValue[]]
}>()

defineSlots<{
  /** Shown under the form in place of its run button, given the values of the inputs and whether a required one is missing. */
  actions?: (props: { inputs: CommandInputValue[], missing: boolean }) => unknown
}>()

const fields = computed(() => commandInputs(props.command.args))
const values = shallowRef<CommandInputValue[]>(props.initial ?? defaultCommandInputs(props.command.args))
const inputs = computed(() => fields.value.map((_, index) => values.value[index] ?? ''))

const preview = computed(() => expandCommandArgs(props.command.args, inputs.value).map(arg => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg)).join(' '))
const missing = computed(() => missingCommandInputs(props.command.args, inputs.value).length > 0)

/**
 * Sets the value of an input.
 * @param index The position of the input.
 * @param value The value.
 */
function set (index: number, value: CommandInputValue): void {
  const next = [...inputs.value]
  next[index] = value
  values.value = next
}

/**
 * Picks a value of a choice, or leaves an optional choice out when its value is picked again.
 * @param index The position of the choice.
 * @param field The choice.
 * @param choice The value.
 */
function pick (index: number, field: CommandInput, choice: string): void {
  set(index, field.optional && inputs.value[index] === choice ? '' : choice)
}
</script>

<template>
  <form
    class="space-y-2"
    @submit.prevent="!missing && emit('run', inputs)"
  >
    <div
      v-for="(field, index) in fields"
      :key="`${index}/${field.name}`"
      class="space-y-1"
    >
      <template v-if="field.kind === 'choice'">
        <p class="text-xs text-muted-foreground">
          {{ field.name }}<span v-if="field.optional"> (optional)</span>
        </p>
        <div
          v-if="field.display === 'dropdown'"
          class="flex items-center gap-1"
        >
          <Select
            :model-value="(inputs[index] as string) || undefined"
            :options="field.choices"
            :placeholder="field.name"
            class="font-mono"
            @update:model-value="(choice) => set(index, choice ?? '')"
          />
          <Button
            v-if="field.optional && inputs[index]"
            type="button"
            variant="ghost"
            size="icon-sm"
            class="shrink-0"
            title="Leave out"
            @click="set(index, '')"
          >
            <X class="size-3.5" />
          </Button>
        </div>
        <div
          v-else
          class="flex flex-wrap gap-1"
        >
          <button
            v-for="choice in field.choices"
            :key="choice.value"
            type="button"
            :class="cn(
              'rounded-md border px-2 py-0.5 font-mono text-xs transition-colors',
              inputs[index] === choice.value ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )"
            :title="choice.label === choice.value ? undefined : choice.value"
            @click="pick(index, field, choice.value)"
          >
            {{ choice.label }}
          </button>
        </div>
      </template>
      <label
        v-else-if="field.kind === 'flag'"
        class="flex items-center gap-2 font-mono text-xs"
      >
        <Checkbox
          :model-value="inputs[index] === true"
          @update:model-value="(checked) => set(index, checked === true)"
        />
        {{ field.name }}
      </label>
      <Input
        v-else
        :model-value="typeof inputs[index] === 'string' ? (inputs[index] as string) : ''"
        class="h-8 font-mono text-xs"
        :placeholder="field.name"
        @update:model-value="(text) => set(index, String(text))"
      />
    </div>

    <div class="flex items-center gap-2">
      <code
        class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
        :title="preview"
      >{{ preview }}</code>
      <Button
        v-if="!$slots.actions"
        type="submit"
        size="sm"
        class="h-8"
        :disabled="missing"
        :title="command.prompt ? 'Runs in the background, questions in a dialog' : 'Runs in a terminal'"
      >
        <MessageSquare
          v-if="command.prompt"
          class="size-3.5"
        />
        <Play
          v-else
          class="size-3.5"
        />
        Run
      </Button>
    </div>
    <slot
      name="actions"
      :inputs="inputs"
      :missing="missing"
    />
  </form>
</template>
