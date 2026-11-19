<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, useTemplateRef, watch } from "vue";
import { useColorMode } from "@vueuse/core";
import * as monaco from "@/lib/monaco";

const props = defineProps<{
  path: string;
  before: string;
  after: string;
}>();

const container = useTemplateRef<HTMLDivElement>("container");
const colorMode = useColorMode({ storageKey: "devtool-color-mode" });
const theme = computed(() => (colorMode.state.value === "dark" ? "vs-dark" : "vs"));
let editor: monaco.editor.IStandaloneDiffEditor | null = null;

onMounted(() => {
  if (!container.value) {
    return;
  }
  editor = monaco.editor.createDiffEditor(container.value, {
    theme: theme.value,
    readOnly: true,
    automaticLayout: true,
    minimap: { enabled: false },
    renderSideBySide: false,
    scrollBeyondLastLine: false,
  });
  editor.setModel({
    original: monaco.editor.createModel(props.before, undefined, monaco.Uri.file(`/before/${props.path}`)),
    modified: monaco.editor.createModel(props.after, undefined, monaco.Uri.file(`/after/${props.path}`)),
  });
});

watch(theme, (value) => monaco.editor.setTheme(value));

onBeforeUnmount(() => {
  const model = editor?.getModel();
  editor?.dispose();
  model?.original.dispose();
  model?.modified.dispose();
  editor = null;
});
</script>

<template>
  <div
    ref="container"
    class="h-64 w-full overflow-hidden rounded-md border"
  />
</template>
