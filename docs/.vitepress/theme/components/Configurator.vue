<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import BackendForm from './configurator/BackendForm.vue'
import ConfigField from './configurator/ConfigField.vue'
import ConfigGroup from './configurator/ConfigGroup.vue'
import ConfigPreview from './configurator/ConfigPreview.vue'
import EntryList from './configurator/EntryList.vue'
import ItemList from './configurator/ItemList.vue'
import ProjectForm from './configurator/ProjectForm.vue'
import {
  AGENT_FIELDS,
  AUTH_FIELDS,
  BUCKET_FIELDS,
  CERTIFICATE_FIELDS,
  DATABASE_FIELDS,
  DEVTOOL_FIELDS,
  ENVIRONMENT_FILE_FIELDS,
  MACHINE_FIELDS,
  S3_FIELDS,
  SECTION_FIELDS
} from './configurator/configFields'
import { asRecord, buildFiles } from './configurator/configFiles'
import { validateConfig } from './configurator/configValidation'
import { provideConfigurator } from './configurator/useConfigurator'
import type { FieldDefinition } from './configurator/configFields'
import type { SplitMode } from './configurator/configFiles'
import type { ConfigPath } from './configurator/useConfigurator'

const EXAMPLE: Record<string, unknown> = {
  workspace: '~/Workspace',
  adt: { displayName: 'Acme Devtool' },
  sections: { acme: { name: 'Acme', path: 'acme' } },
  projects: {
    api: {
      section: 'acme',
      name: 'API',
      default: { action: 'command:dev' },
      commands: {
        dev: { name: 'Dev server', args: ['pnpm', 'dev'], startWithSection: true },
        test: { name: 'Tests', args: ['pnpm', 'test'] }
      },
      services: { api: { host: 'api.example.dev', target: 3000, tls: true } }
    },
    web: {
      section: 'acme',
      name: 'Web',
      default: { action: 'command:dev' },
      commands: { dev: { name: 'Vite', args: ['pnpm', 'dev'], startWithSection: true } },
      services: { web: { host: 'web.example.dev', target: 5173, tls: true } }
    }
  }
}

const ENVIRONMENT_LISTS: { title: string, path: ConfigPath, addLabel: string, fields: FieldDefinition[], newItem: () => Record<string, unknown> }[] = [
  { title: 'Files', path: ['environment', 'files'], addLabel: 'Add a file', fields: ENVIRONMENT_FILE_FIELDS, newItem: () => ({ path: 'api/config.yml' }) },
  { title: 'Databases', path: ['environment', 'databases'], addLabel: 'Add a database', fields: DATABASE_FIELDS, newItem: () => ({ path: 'api/db.gz', engine: 'postgres', container: 'postgres' }) },
  { title: 'Buckets', path: ['environment', 'buckets'], addLabel: 'Add a bucket', fields: BUCKET_FIELDS, newItem: () => ({ path: 'api/s3.gz', bucket: 'uploads' }) }
]

const store = provideConfigurator(EXAMPLE)
const mode = shallowRef<SplitMode>('single')
const files = computed(() => buildFiles(store.config.value, mode.value))
const problems = computed(() => validateConfig(store.config.value))
const sections = computed(() => Object.keys(asRecord(store.config.value.sections)))

/**
 * Creates a section entry.
 * @returns The new section.
 */
function newSection (): Record<string, unknown> {
  return { name: 'New section' }
}

/**
 * Creates a project entry, placed in the first section.
 * @returns The new project.
 */
function newProject (): Record<string, unknown> {
  return { name: 'New project', section: sections.value[0] }
}

/**
 * Creates a backend entry, a CDN by default.
 * @returns The new backend.
 */
function newBackend (): Record<string, unknown> {
  return { type: 'cdn', url: 'https://files.example.dev' }
}

/**
 * Creates a certificate entry.
 * @returns The new certificate.
 */
function newCertificate (): Record<string, unknown> {
  return { crt: 'certs/example.dev.crt', key: 'certs/example.dev.key' }
}

/**
 * Starts over from the example configuration.
 */
function startFromExample (): void {
  store.replace(structuredClone(EXAMPLE))
}
</script>

<template>
  <div class="configurator">
    <div class="forms">
      <div class="start">
        <span>Start from</span>
        <button type="button" @click="startFromExample">
          the example
        </button>
        <button type="button" @click="store.replace({})">
          an empty file
        </button>
      </div>

      <ConfigGroup title="Your machine" description="Personal settings, written to config.local.yml and never shared." open>
        <ConfigField v-for="field in MACHINE_FIELDS" :key="field.label" v-bind="field" />
      </ConfigGroup>

      <ConfigGroup title="Devtool" description="How the devtool names and shows itself, and its ports.">
        <ConfigField v-for="field in DEVTOOL_FIELDS" :key="field.label" v-bind="field" />
      </ConfigGroup>

      <ConfigGroup title="Sections" description="Groups of projects in the sidebar, usually one per repository." open>
        <EntryList
          :path="['sections']"
          base="section"
          add-label="Add a section"
          :new-entry="newSection"
        >
          <template #default="{ path }">
            <ConfigField
              v-for="field in SECTION_FIELDS"
              :key="field.label"
              v-bind="field"
              :path="[...path, ...field.path]"
            />
          </template>
        </EntryList>
      </ConfigGroup>

      <ConfigGroup title="Projects" description="Folders with their commands, services, files and integrations." open>
        <EntryList
          :path="['projects']"
          base="project"
          add-label="Add a project"
          :new-entry="newProject"
        >
          <template #default="{ path }">
            <ProjectForm :path="path" :sections="sections" />
          </template>
        </EntryList>
      </ConfigGroup>

      <ConfigGroup title="Certificates" description="HTTPS certificates of the load balancer, by domain.">
        <EntryList
          :path="['loadBalancers']"
          base="example.dev"
          add-label="Add a certificate"
          :new-entry="newCertificate"
        >
          <template #default="{ path }">
            <ConfigField
              v-for="field in CERTIFICATE_FIELDS"
              :key="field.label"
              v-bind="field"
              :path="[...path, ...field.path]"
            />
          </template>
        </EntryList>
      </ConfigGroup>

      <ConfigGroup title="Environment" description="Files, databases and buckets shared through the backends.">
        <template v-for="list in ENVIRONMENT_LISTS" :key="list.title">
          <h4>{{ list.title }}</h4>
          <ItemList :path="list.path" :add-label="list.addLabel" :new-item="list.newItem">
            <template #default="{ path }">
              <ConfigField
                v-for="field in list.fields"
                :key="field.label"
                v-bind="field"
                :path="[...path, ...field.path]"
              />
            </template>
          </ItemList>
        </template>
        <ConfigField v-for="field in S3_FIELDS" :key="field.label" v-bind="field" />
      </ConfigGroup>

      <ConfigGroup title="Sign-in" description="The identity provider signing developers in, for the cdn backends and the auth:// value blocks.">
        <ConfigField v-for="field in AUTH_FIELDS" :key="field.label" v-bind="field" />
      </ConfigGroup>

      <ConfigGroup title="Backends" description="Where the environment is stored: a CDN, S3, SFTP, git or your own scripts.">
        <EntryList
          :path="['environment', 'backends']"
          base="team"
          add-label="Add a backend"
          :new-entry="newBackend"
        >
          <template #default="{ path }">
            <BackendForm :path="path" />
          </template>
        </EntryList>
      </ConfigGroup>

      <ConfigGroup title="Agents" description="The MCP server coding agents connect to, and what they may do.">
        <ConfigField v-for="field in AGENT_FIELDS" :key="field.label" v-bind="field" />
      </ConfigGroup>
    </div>

    <ConfigPreview
      v-model:mode="mode"
      class="preview"
      :files="files"
      :problems="problems"
      @import="store.replace"
    />
  </div>
</template>

<style scoped>
.configurator {
  display: grid;
  gap: 24px;
  margin-top: 24px;
}

@media (min-width: 1100px) {
  .configurator {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    align-items: start;
  }

  .preview {
    position: sticky;
    top: calc(var(--vp-nav-height) + 16px);
  }
}

.forms {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.start {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--vp-c-text-2);
}

.start button {
  padding: 4px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.start button:hover {
  border-color: var(--vp-c-brand-1);
}

h4 {
  grid-column: 1 / -1;
  margin: 8px 0 0;
  font-family: var(--vp-font-family-heading);
  font-size: 14px;
}
</style>
