<script setup lang="ts">
import { computed } from 'vue'
import ArgsField from './ArgsField.vue'
import ConfigField from './ConfigField.vue'
import EntryList from './EntryList.vue'
import { COMMAND_FIELDS, FILES_FIELDS, INTEGRATION_FIELDS, PROJECT_FIELDS, SERVICE_FIELDS } from './configFields'
import { asRecord } from './configFiles'
import { useConfigurator } from './useConfigurator'
import type { FieldDefinition } from './configFields'
import type { ConfigPath } from './useConfigurator'

const props = defineProps<{
  path: ConfigPath
  sections: readonly string[]
}>()

interface EntryGroup {
  title: string
  key: string
  base: string
  addLabel: string
  fields: FieldDefinition[]
  newEntry: () => Record<string, unknown>
}

const GROUPS: EntryGroup[] = [
  { title: 'Commands', key: 'commands', base: 'dev', addLabel: 'Add a command', fields: COMMAND_FIELDS, newEntry: () => ({ name: 'Dev server', args: ['pnpm', 'dev'] }) },
  { title: 'Services', key: 'services', base: 'web', addLabel: 'Add a service', fields: SERVICE_FIELDS, newEntry: () => ({ host: 'web.example.dev', target: 5173 }) },
  { title: 'Files', key: 'files', base: 'config', addLabel: 'Add a folder of files', fields: FILES_FIELDS, newEntry: () => ({ name: 'Config', path: 'config' }) },
  { title: 'Integrations', key: 'integrations', base: 'pulls', addLabel: 'Add an integration', fields: INTEGRATION_FIELDS, newEntry: () => ({ name: 'Pull requests', type: 'pullRequests' }) }
]

const store = useConfigurator()
const commands = computed(() => Object.keys(asRecord(store.get([...props.path, 'commands']))))
const sectionField = computed<FieldDefinition>(() => ({ path: [...props.path, 'section'], label: 'Section', type: 'select', options: props.sections }))

const defaultCommand = computed({
  get: () => {
    const action = asRecord(store.get([...props.path, 'default'])).action
    return typeof action === 'string' && action.startsWith('command:') ? action.slice('command:'.length) : undefined
  },
  set: (slug: string | undefined) => {
    store.set([...props.path, 'default'], slug ? { action: `command:${slug}` } : undefined)
  }
})
</script>

<template>
  <ConfigField
    v-for="field in PROJECT_FIELDS"
    :key="field.label"
    v-bind="field"
    :path="[...path, ...field.path]"
  />
  <ConfigField v-bind="sectionField" />
  <label class="main-command">
    <span>Main command</span>
    <select v-model="defaultCommand">
      <option :value="undefined">-</option>
      <option v-for="slug in commands" :key="slug" :value="slug">
        {{ slug }}
      </option>
    </select>
  </label>

  <template v-for="group in GROUPS" :key="group.key">
    <h4>{{ group.title }}</h4>
    <EntryList
      :path="[...path, group.key]"
      :base="group.base"
      :add-label="group.addLabel"
      :new-entry="group.newEntry"
    >
      <template #default="{ path: entryPath }">
        <ConfigField
          v-for="field in group.fields"
          :key="field.label"
          v-bind="field"
          :path="[...entryPath, ...field.path]"
        />
        <ArgsField
          v-if="group.key === 'commands'"
          :path="[...entryPath, 'args']"
          label="Command line"
          placeholder="pnpm dev --port 5173"
        />
      </template>
    </EntryList>
  </template>
</template>

<style scoped>
h4 {
  grid-column: 1 / -1;
  margin: 8px 0 0;
  font-family: var(--vp-font-family-heading);
  font-size: 14px;
}

.main-command {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  font-weight: 600;
}

.main-command select {
  padding: 6px 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  font-weight: 400;
}
</style>
