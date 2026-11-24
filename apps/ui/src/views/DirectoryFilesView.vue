<script setup lang="ts">
import { computed } from 'vue'
import FileSpaceView from '@/views/FileSpaceView.vue'
import configStore from '@/stores/config'

const props = defineProps<{
  projectSlug: string
  directorySlug: string
  fileSpace: string
}>()

const directory = computed(() => configStore.getDirectory(props.projectSlug, props.directorySlug)?.directory ?? null)
const files = computed(() => directory.value?.files[props.fileSpace] ?? null)
const commands = computed(() => files.value?.commands.map(slug => directory.value?.extras[slug]).filter(command => command !== undefined) ?? [])
</script>

<template>
  <FileSpaceView
    v-if="files"
    :key="`${projectSlug}/${directorySlug}/${fileSpace}`"
    :space="`${projectSlug}/${directorySlug}/${fileSpace}`"
    :name="files.name"
    :commands="commands"
    :restore="files.restore ? (directory?.extras[files.restore] ?? null) : null"
    :project-slug="projectSlug"
    :directory-slug="directorySlug"
  />
  <p
    v-else
    class="p-6 text-sm text-muted-foreground"
  >
    No folder of files {{ fileSpace }} in this directory.
  </p>
</template>
