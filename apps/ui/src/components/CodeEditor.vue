<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue'
import { useColorMode } from '@vueuse/core'
import * as monaco from '@/lib/monaco'

const props = defineProps<{
  path: string
}>()

const content = defineModel<string>({ required: true })

const emit = defineEmits<{
  save: []
}>()

const container = useTemplateRef<HTMLDivElement>('container')
const colorMode = useColorMode({ storageKey: 'devtool-color-mode' })
const theme = computed(() => (colorMode.state.value === 'dark' ? 'vs-dark' : 'vs'))
let editor: monaco.editor.IStandaloneCodeEditor | null = null

/**
 * Creates the model of a file, its language guessed from its extension.
 * @param path The path of the file.
 * @param value Its content.
 * @returns The model.
 */
function createModel (path: string, value: string): monaco.editor.ITextModel {
  return monaco.editor.createModel(value, undefined, monaco.Uri.file(path))
}

onMounted(() => {
  if (!container.value) {
    return
  }

  editor = monaco.editor.create(container.value, {
    model: createModel(props.path, content.value),
    theme: theme.value,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    tabSize: 2
  })
  editor.onDidChangeModelContent(() => {
    content.value = editor?.getValue() ?? ''
  })
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => emit('save'))
})

watch(
  () => props.path,
  path => {
    const previous = editor?.getModel()
    editor?.setModel(createModel(path, content.value))
    previous?.dispose()
  }
)

watch(theme, value => monaco.editor.setTheme(value))

watch(content, value => {
  if (editor && editor.getValue() !== value) {
    editor.setValue(value)
  }
})

onBeforeUnmount(() => {
  editor?.getModel()?.dispose()
  editor?.dispose()
  editor = null
})
</script>

<template>
  <div
    ref="container"
    class="h-full w-full"
  />
</template>
