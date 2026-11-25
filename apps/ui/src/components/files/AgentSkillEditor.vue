<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import { TriangleAlert } from '@lucide/vue'
import { type AgentSkillFields, readAgentSkill, withAgentSkillBody, withAgentSkillFields } from '@appsys-sas/devtool-shared'
import CodeEditor from '@/components/CodeEditor.vue'
import MarkdownPreview from '@/components/files/MarkdownPreview.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const DESCRIPTION_MAX_LENGTH = 1024

const props = defineProps<{
  /** The path of the `SKILL.md` in its file space. */
  path: string
  /** The folder of the skill. */
  folder: string
  /** Whether the instructions are shown rendered next to the editor. */
  preview: boolean
}>()

const content = defineModel<string>({ required: true })

const emit = defineEmits<{
  save: []
}>()

const mode = shallowRef<'form' | 'source'>('form')

const skill = computed(() => readAgentSkill(content.value, props.folder))
const body = computed({
  get: () => skill.value.body,
  set: value => {
    content.value = withAgentSkillBody(content.value, value)
  }
})

/**
 * Sets a field of the header of the skill in its content.
 * @param field The field.
 * @param value Its new value.
 */
function setField (field: keyof AgentSkillFields, value: string | number): void {
  content.value = withAgentSkillFields(content.value, { [field]: String(value) })
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-1 border-b px-4 py-1.5">
      <Button
        v-for="item in (['form', 'source'] as const)"
        :key="item"
        size="sm"
        :variant="mode === item ? 'secondary' : 'ghost'"
        class="h-7"
        @click="mode = item"
      >
        {{ item === "form" ? "Skill" : "Source" }}
      </Button>
    </div>

    <div
      v-if="mode === 'form'"
      class="space-y-3 border-b p-4"
    >
      <label class="block space-y-1">
        <span class="text-xs font-medium text-muted-foreground">Name</span>
        <Input
          :model-value="skill.name ?? ''"
          :disabled="skill.error !== null"
          class="font-mono"
          @update:model-value="setField('name', $event)"
        />
      </label>
      <label class="block space-y-1">
        <span class="flex justify-between text-xs font-medium text-muted-foreground">
          Description
          <span :class="cn('tabular-nums', (skill.description?.length ?? 0) > DESCRIPTION_MAX_LENGTH && 'text-destructive')">
            {{ skill.description?.length ?? 0 }} / {{ DESCRIPTION_MAX_LENGTH }}
          </span>
        </span>
        <textarea
          :value="skill.description ?? ''"
          :disabled="skill.error !== null"
          rows="3"
          class="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
          @input="setField('description', ($event.target as HTMLTextAreaElement).value)"
        />
      </label>
      <ul
        v-if="skill.problems.length"
        class="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400"
      >
        <li
          v-for="problem in skill.problems"
          :key="problem"
          class="flex items-start gap-2"
        >
          <TriangleAlert class="mt-0.5 size-3.5 shrink-0" />
          <span class="whitespace-pre-wrap">{{ problem }}<template v-if="skill.error">: fix it in Source.</template></span>
        </li>
      </ul>
    </div>
    <div class="flex min-h-0 flex-1">
      <div class="min-w-0 flex-1">
        <CodeEditor
          v-if="mode === 'form'"
          key="body"
          v-model="body"
          :path="`${folder}/.body/${path.split('/').pop()}`"
          @save="emit('save')"
        />
        <CodeEditor
          v-else
          key="source"
          v-model="content"
          :path="path"
          @save="emit('save')"
        />
      </div>
      <MarkdownPreview
        v-if="preview"
        :source="content"
        class="min-w-0 flex-1 border-l"
      />
    </div>
  </div>
</template>
