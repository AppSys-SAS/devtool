<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { parse } from 'yaml'
import { asRecord, zipFiles } from './configFiles'
import type { ConfigFile, SplitMode } from './configFiles'
import type { ConfigProblem } from './configValidation'

const props = defineProps<{
  files: ConfigFile[]
  problems: ConfigProblem[]
}>()

const emit = defineEmits<{
  import: [config: Record<string, unknown>]
}>()

const mode = defineModel<SplitMode>('mode', { required: true })

const MODES: { mode: SplitMode, label: string }[] = [
  { mode: 'single', label: 'One file' },
  { mode: 'split', label: 'One file per project' }
]

const selected = shallowRef('config.yml')
const copied = shallowRef(false)
const importing = shallowRef(false)
const importText = shallowRef('')
const importError = shallowRef('')

const current = computed(() => props.files.find(file => file.path === selected.value) ?? props.files[0])

watch(() => props.files.map(file => file.path), paths => {
  if (!paths.includes(selected.value)) {
    selected.value = paths[0]
  }
})

/**
 * Copies the shown file to the clipboard.
 */
async function copy (): Promise<void> {
  await navigator.clipboard.writeText(current.value.content)
  copied.value = true
  setTimeout(() => {
    copied.value = false
  }, 1500)
}

/**
 * Downloads the shown file, or every file as a zip when there are several.
 */
function download (): void {
  const single = props.files.length === 1
  const blob = single
    ? new Blob([props.files[0].content], { type: 'text/yaml' })
    : new Blob([zipFiles(props.files) as Uint8Array<ArrayBuffer>], { type: 'application/zip' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = single ? props.files[0].path : 'devtool-config.zip'
  link.click()
  URL.revokeObjectURL(link.href)
}

/**
 * Loads the pasted YAML as the configuration being edited.
 */
function applyImport (): void {
  try {
    const config = asRecord(parse(importText.value))
    importError.value = Object.keys(config).length === 0 ? 'Paste a YAML map, such as the content of config.yml.' : ''
    if (!importError.value) {
      emit('import', config)
      importing.value = false
      importText.value = ''
    }
  } catch (error) {
    importError.value = error instanceof Error ? error.message : String(error)
  }
}

/**
 * Reads a chosen YAML file into the import field.
 * @param event The change event of the file input.
 */
async function readFile (event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) {
    importText.value = await file.text()
  }
}
</script>

<template>
  <div class="config-preview">
    <div class="toolbar">
      <div class="modes" role="radiogroup" aria-label="Files">
        <button
          v-for="option in MODES"
          :key="option.mode"
          type="button"
          role="radio"
          :aria-checked="mode === option.mode"
          :class="{ active: mode === option.mode }"
          @click="mode = option.mode"
        >
          {{ option.label }}
        </button>
      </div>
      <div class="actions">
        <button type="button" @click="importing = !importing">
          Import
        </button>
        <button type="button" @click="copy">
          {{ copied ? 'Copied' : 'Copy' }}
        </button>
        <button type="button" class="primary" @click="download">
          {{ files.length > 1 ? 'Download .zip' : 'Download' }}
        </button>
      </div>
    </div>

    <div v-if="importing" class="import">
      <textarea
        v-model="importText"
        rows="8"
        placeholder="Paste your config.yml here"
        spellcheck="false"
      />
      <div class="import-actions">
        <input type="file" accept=".yml,.yaml" @change="readFile">
        <button type="button" class="primary" @click="applyImport">
          Load
        </button>
      </div>
      <p v-if="importError" class="error">
        {{ importError }}
      </p>
      <p class="note">
        Files named in <code>include</code> are not loaded: import them one after the other.
      </p>
    </div>

    <div class="tabs" role="tablist">
      <button
        v-for="file in files"
        :key="file.path"
        type="button"
        role="tab"
        :aria-selected="file.path === current.path"
        :class="{ active: file.path === current.path }"
        @click="selected = file.path"
      >
        {{ file.path }}
      </button>
    </div>
    <pre class="code"><code>{{ current.content }}</code></pre>

    <div class="status" :class="{ valid: problems.length === 0 }">
      <template v-if="problems.length === 0">
        Valid configuration
      </template>
      <template v-else>
        <strong>{{ problems.length }} {{ problems.length > 1 ? 'problems' : 'problem' }}</strong>
        <ul>
          <li v-for="problem in problems.slice(0, 8)" :key="problem.path">
            <code>{{ problem.path }}</code> {{ problem.message }}
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>

<style scoped>
.config-preview {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.toolbar,
.actions,
.modes,
.import-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.toolbar {
  justify-content: space-between;
}

button {
  padding: 4px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  transition: border-color 0.2s, background-color 0.2s;
}

button:hover {
  border-color: var(--vp-c-brand-1);
}

button.active {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
}

button.primary {
  border-color: var(--vp-button-brand-bg);
  background: var(--vp-button-brand-bg);
  color: #fff;
}

.tabs {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  border-bottom: 1px solid var(--vp-c-divider);
}

.tabs button {
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  font-family: var(--vp-font-family-mono);
  font-weight: 400;
  white-space: nowrap;
}

.tabs button.active {
  border-bottom-color: var(--vp-c-brand-1);
  background: none;
}

.code {
  max-height: 560px;
  margin: 0;
  padding: 16px;
  overflow: auto;
  border-radius: 12px;
  background: var(--vp-code-block-bg);
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.6;
}

.import {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

textarea {
  width: 100%;
  padding: 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
}

.note {
  margin: 0;
  font-size: 12px;
  color: var(--vp-c-text-2);
}

.status {
  padding: 10px 14px;
  border-left: 4px solid #e24e4d;
  border-radius: 8px;
  background: rgba(246, 103, 102, 0.1);
  font-size: 13px;
}

.status.valid {
  border-left-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}

.status ul,
.error {
  margin: 4px 0 0;
}

.error {
  color: #e24e4d;
  font-size: 13px;
}
</style>
