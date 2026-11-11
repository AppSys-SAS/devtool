<script setup lang="ts">
import { computed, ref } from "vue";
import { MessageSquare, Play } from "@lucide/vue";
import type { ScriptArgument, ScriptPayload } from "@appsys/devtool-shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const props = defineProps<{
  script: ScriptPayload;
}>();

const emit = defineEmits<{
  run: [args: string[]];
}>();

const FREE_ARGUMENTS: ScriptArgument[] = [{ name: "arguments", kind: "text", choices: [], optional: true }];

const fields = computed(() => props.script.args ?? FREE_ARGUMENTS);
const values = ref<Record<number, string | boolean>>({});

/**
 * Splits arguments typed on one line, words in single or double quotes kept together.
 * @param text The line.
 * @returns The arguments.
 */
function splitArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

const argv = computed(() =>
  fields.value.flatMap((field, index) => {
    const value = values.value[index];
    if (field.kind === "flag") {
      return value === true ? [field.name] : [];
    }
    if (field.kind === "text") {
      return typeof value === "string" ? splitArgs(value) : [];
    }
    return typeof value === "string" && value ? [value] : [];
  }),
);
const preview = computed(() => [props.script.path, ...argv.value].map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg)).join(" "));
const missing = computed(() => fields.value.some((field, index) => field.kind === "choice" && !field.optional && !values.value[index]));

/**
 * Picks a value of a choice, or leaves an optional choice out when its value is picked again.
 * @param index The position of the choice.
 * @param field The choice.
 * @param choice The value.
 */
function pick(index: number, field: ScriptArgument, choice: string): void {
  values.value = { ...values.value, [index]: field.optional && values.value[index] === choice ? "" : choice };
}
</script>

<template>
  <form
    class="space-y-2"
    @submit.prevent="!missing && emit('run', argv)"
  >
    <div
      v-for="(field, index) in fields"
      :key="`${field.kind}/${field.name}`"
      class="space-y-1"
    >
      <template v-if="field.kind === 'choice'">
        <p class="text-xs text-muted-foreground">
          {{ field.name }}<span v-if="field.optional"> (optional)</span>
        </p>
        <div class="flex flex-wrap gap-1">
          <button
            v-for="choice in field.choices"
            :key="choice"
            type="button"
            :class="cn(
              'rounded-md border px-2 py-0.5 font-mono text-xs transition-colors',
              values[index] === choice ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )"
            @click="pick(index, field, choice)"
          >
            {{ choice }}
          </button>
        </div>
      </template>
      <label
        v-else-if="field.kind === 'flag'"
        class="flex items-center gap-2 font-mono text-xs"
      >
        <Checkbox
          :model-value="values[index] === true"
          @update:model-value="(checked) => (values = { ...values, [index]: checked === true })"
        />
        {{ field.name }}
      </label>
      <Input
        v-else
        :model-value="typeof values[index] === 'string' ? (values[index] as string) : ''"
        class="h-8 font-mono text-xs"
        :placeholder="field.name"
        @update:model-value="(text) => (values = { ...values, [index]: String(text) })"
      />
    </div>

    <div class="flex items-center gap-2">
      <code
        class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
        :title="preview"
      >{{ preview }}</code>
      <Button
        type="submit"
        size="sm"
        class="h-8"
        :disabled="missing"
        :title="script.prompt ? 'Runs in the background, questions in a dialog' : 'Runs in a terminal'"
      >
        <MessageSquare
          v-if="script.prompt"
          class="size-3.5"
        />
        <Play
          v-else
          class="size-3.5"
        />
        Run
      </Button>
    </div>
  </form>
</template>
