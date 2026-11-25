<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import { Check, Pencil, X } from '@lucide/vue'
import { type IntegrationDefinition, MCP_ACTIONS, type McpAction, type McpLevel, type McpPatterns, type McpRules, type McpTarget } from '@appsys/devtool-shared'
import ConfigFileChoice from '@/components/ConfigFileChoice.vue'
import McpRulesRow from '@/components/mcp/McpRulesRow.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { changeKey, type McpEditMode, type McpLevelChange } from '@/lib/mcp'
import configStore from '@/stores/config'
import mcpStore from '@/stores/mcp'

const COMMAND_ACTIONS: readonly McpAction[] = ['read', 'run', 'input', 'control']
const FILE_ACTIONS: readonly McpAction[] = ['read', 'write']
const CERTIFICATE_ACTIONS: readonly McpAction[] = ['read', 'run']
const ENVIRONMENT_ACTIONS: readonly McpAction[] = ['read', 'run', 'write']
const DATA_ACTIONS: readonly McpAction[] = ['read', 'run']
const INTEGRATION_ACTIONS: readonly McpAction[] = ['read']
const INTEGRATION_KINDS: Record<string, string> = { pullRequests: 'pull requests', issues: 'issues' }
const OWN_TERMINAL_LEVELS: readonly McpLevel[] = ['allow', 'ask']
const PATTERN_LEVELS: readonly McpLevel[] = ['allow', 'ask', 'deny']

/** A global setting of `adt.mcp`, as a row of the card. */
interface SettingRow {
  label: string
  kind: string
  rules: McpRules
  actions: readonly McpAction[]
  target: McpTarget
  /** The levels of a setting being a level itself. */
  levels?: readonly McpLevel[]
  /** Shown in place of the action of a setting being a level itself. */
  caption?: string
}

const settings = configStore.mcp
const projects = computed(() => Object.values(configStore.projects.value ?? {}))
const granted = computed(() => new Set(mcpStore.state.value?.grants.filter(grant => grant.scope === 'always').map(grant => grant.key)))

const editFile = shallowRef<McpEditMode['file'] | null>(null)
const staged = shallowRef<ReadonlyMap<string, McpLevelChange>>(new Map())
const edit = computed<McpEditMode | null>(() =>
  editFile.value
    ? {
        file: editFile.value,
        localFile: settings.value?.localFile ?? null,
        staged: staged.value,
        stage: change => {
          staged.value = new Map(staged.value).set(changeKey(change.path, change.action), change)
        }
      }
    : null
)

/**
 * Enters the edit mode, writing to the personal override when there is one.
 */
function startEdit (): void {
  editFile.value = settings.value?.localFile ? 'local' : 'declared'
}

/**
 * Leaves the edit mode, writing the changes waiting when they are kept.
 * @param keep Whether the changes are written, or dropped.
 */
function endEdit (keep: boolean): void {
  if (keep && staged.value.size) {
    mcpStore.setLevels([...staged.value.values()])
  }
  staged.value = new Map()
  editFile.value = null
}

/**
 * Gives every action the same level, for a setting ruling some actions only.
 * @param level The level.
 * @param from The setting.
 * @returns The rules, the row showing only the actions the setting rules.
 */
function uniformRules (level: McpLevel, from: string): McpRules {
  return Object.fromEntries(MCP_ACTIONS.map(action => [action, { level, from }])) as McpRules
}

/**
 * Names a folder of scripts by its own name.
 * @param folder The absolute path of the folder.
 * @returns Its name.
 */
function folderName (folder: string): string {
  return folder.split('/').slice(-1)[0] ?? folder
}

/**
 * Describes a setting made of a level and patterns overriding it.
 * @param kind What the setting rules.
 * @param patterns The level and its patterns.
 * @returns The description, the patterns after it.
 */
function patternsKind (kind: string, patterns: McpPatterns): string {
  return [kind, patterns.allow.length ? `allow ${patterns.allow.join(', ')}` : null, patterns.deny.length ? `deny ${patterns.deny.join(', ')}` : null].filter(Boolean).join(' · ')
}

const settingRows = computed<SettingRow[]>(() => {
  const value = settings.value
  if (!value) {
    return []
  }
  const { targets } = value
  return [
    {
      label: 'adt.mcp.clients',
      kind: patternsKind('agents accepted before any rule', value.clients),
      rules: uniformRules(value.clients.level, 'adt.mcp.clients.level'),
      actions: ['read'],
      target: targets.clients,
      levels: PATTERN_LEVELS,
      caption: 'accept'
    },
    { label: 'adt.mcp.default', kind: 'everything, refined below', rules: value.default, actions: MCP_ACTIONS, target: targets.default },
    { label: 'adt.mcp.commands', kind: 'commands of the configuration and restores', rules: value.commands, actions: COMMAND_ACTIONS, target: targets.commands },
    { label: 'adt.mcp.scripts', kind: 'executables of the folders of scripts', rules: value.scripts, actions: COMMAND_ACTIONS, target: targets.scripts },
    { label: 'adt.mcp.files', kind: 'folders of files of the projects', rules: value.files, actions: FILE_ACTIONS, target: targets.files },
    { label: 'adt.mcp.terminals', kind: 'terminals a person opened without a command', rules: value.terminals, actions: COMMAND_ACTIONS, target: targets.terminals },
    {
      label: 'adt.mcp.ownTerminals',
      kind: 'the terminals an agent started itself',
      rules: uniformRules(value.ownTerminals, 'adt.mcp.ownTerminals'),
      actions: ['input', 'control'],
      target: targets.ownTerminals,
      levels: OWN_TERMINAL_LEVELS
    },
    {
      label: 'adt.mcp.shell',
      kind: patternsKind('command lines outside the configuration', value.shell),
      rules: uniformRules(value.shell.level, 'adt.mcp.shell.level'),
      actions: ['run'],
      target: targets.shell,
      levels: PATTERN_LEVELS
    },
    { label: 'adt.mcp.devtool', kind: 'holders of a port (read), reloading the configuration (control)', rules: value.devtool, actions: ['read', 'control'], target: targets.devtool },
    { label: 'adt.mcp.integrations', kind: 'pull requests and issues of the integrations, refined below', rules: value.integrations, actions: INTEGRATION_ACTIONS, target: targets.integrations },
    { label: 'adt.mcp.certificates', kind: 'every certificate, refined below', rules: value.certificates, actions: CERTIFICATE_ACTIONS, target: targets.certificates }
  ]
})

const servedSkills = computed<string[]>(() => [
  ...(settings.value?.skills ? ['the skills of the devtool'] : []),
  ...projects.value.flatMap(section => Object.values(section.directories).flatMap(project => Object.values(project.files).flatMap(files =>
    files.mcpSkills ? [`${section.slug}/${project.slug}/${files.slug} (${files.mcpSkills.join(', ')})`] : []
  )))
])

/**
 * Keeps the integrations agents may read the items of: the pull requests and the issues.
 * @param integrations The integrations of a section or a project.
 * @returns Those with rules, and their rules and target.
 */
function forgeIntegrations (integrations: IntegrationDefinition[]): (IntegrationDefinition & { mcp: McpRules, mcpTarget: McpTarget })[] {
  return integrations.filter((integration): integration is IntegrationDefinition & { mcp: McpRules, mcpTarget: McpTarget } => integration.mcp !== null && integration.mcpTarget !== null)
}
</script>

<template>
  <Card v-if="settings">
    <CardHeader class="flex flex-row items-start justify-between gap-3">
      <div class="space-y-1.5">
        <CardTitle>Effective permissions</CardTitle>
        <CardDescription>
          The level of every action as the configuration resolves it. Hover a level to see where it comes from, ✓ marks a call granted always.
        </CardDescription>
      </div>
      <div
        v-if="edit"
        class="flex shrink-0 items-center gap-2"
      >
        <Button
          size="sm"
          variant="ghost"
          class="gap-1.5"
          @click="endEdit(false)"
        >
          <X class="size-3.5" />
          Cancel
        </Button>
        <Button
          size="sm"
          class="gap-1.5"
          @click="endEdit(true)"
        >
          <Check class="size-3.5" />
          {{ staged.size ? `Done (${staged.size})` : "Done" }}
        </Button>
      </div>
      <Button
        v-else
        size="sm"
        variant="outline"
        class="shrink-0 gap-1.5"
        @click="startEdit"
      >
        <Pencil class="size-3.5" />
        Edit
      </Button>
    </CardHeader>
    <CardContent class="space-y-3">
      <ConfigFileChoice
        v-if="editFile"
        v-model="editFile"
        :local-file="settings.localFile"
        shared-hint="Each row shows the file it changes, shared with the others once pushed or committed."
      />

      <div class="space-y-1">
        <McpRulesRow
          v-for="row in settingRows"
          :key="row.label"
          :label="row.label"
          :kind="row.kind"
          :rules="row.rules"
          :actions="row.actions"
          :depth="0"
          :granted="granted"
          :target="row.target"
          :levels="row.levels"
          :caption="row.caption"
          :edit="edit"
        />
        <McpRulesRow
          v-for="(certificate, name) in settings.certificatesByName"
          :key="`certificate/${name}`"
          :label="name"
          kind="certificate"
          :rules="certificate.rules"
          :actions="CERTIFICATE_ACTIONS"
          :depth="1"
          :grant-id="`certificate:${name}`"
          :granted="granted"
          :target="certificate.target"
          :edit="edit"
        />
        <p class="px-2 py-1 text-xs text-muted-foreground">
          <code>notify_user</code> is always allowed: it only shows a message in this interface. Writing the configuration of the devtool is always refused.
        </p>
        <p class="px-2 py-1 text-xs text-muted-foreground">
          <template v-if="servedSkills.length">
            Skills served over MCP, readable by every connected agent without asking: {{ servedSkills.join(" · ") }}.
          </template>
          <template v-else>
            No skill is served over MCP (<code>adt.mcp.skills</code>, <code>mcpSkills</code> of the folders of agent skills).
          </template>
        </p>
      </div>

      <div class="space-y-1 border-t pt-2">
        <McpRulesRow
          label="environment"
          kind="configs, pulls and pushes, refined by each item"
          :rules="settings.environment"
          :actions="ENVIRONMENT_ACTIONS"
          :depth="0"
          :granted="granted"
          :target="settings.targets.environment"
          :edit="edit"
        />
        <McpRulesRow
          v-for="item in settings.environmentItems"
          :key="`environment/${item.kind}/${item.path}`"
          :label="item.path"
          :kind="item.kind"
          :rules="item.rules"
          :actions="item.kind === 'file' ? ENVIRONMENT_ACTIONS : DATA_ACTIONS"
          :depth="1"
          :grant-id="`environment:${item.path}`"
          :granted="granted"
          :target="item.target"
          :edit="edit"
        />
      </div>

      <div
        v-for="section in projects"
        :key="section.slug"
        class="space-y-1 border-t pt-2"
      >
        <McpRulesRow
          :label="section.slug"
          kind="section"
          :rules="section.mcp"
          :actions="MCP_ACTIONS"
          :depth="0"
          :granted="granted"
          :target="section.slug === 'uncategorized' ? undefined : section.mcpTarget"
          :edit="edit"
        />
        <McpRulesRow
          v-for="integration in forgeIntegrations(section.integrations)"
          :key="`${section.slug}/integrations/${integration.slug}`"
          :label="integration.slug"
          :kind="INTEGRATION_KINDS[integration.type]"
          :rules="integration.mcp"
          :actions="INTEGRATION_ACTIONS"
          :depth="1"
          :grant-id="integration.type"
          :granted="granted"
          :target="integration.mcpTarget"
          :edit="edit"
        />
        <template
          v-for="project in section.directories"
          :key="`${section.slug}/${project.slug}`"
        >
          <McpRulesRow
            :label="project.slug"
            kind="project"
            :rules="project.mcp"
            :actions="MCP_ACTIONS"
            :depth="1"
            :granted="granted"
            :target="project.mcpTarget"
            :edit="edit"
          />
          <McpRulesRow
            v-for="folder in project.scripts"
            :key="`${section.slug}/${project.slug}/scripts/${folder.path}`"
            :label="`${folderName(folder.path)}/`"
            kind="folder of scripts"
            :rules="folder.mcp"
            :actions="COMMAND_ACTIONS"
            :depth="2"
            :granted="granted"
            :target="folder.mcpTarget"
            :edit="edit"
          />
          <McpRulesRow
            v-for="command in project.extras"
            :key="`${section.slug}/${project.slug}/${command.slug}`"
            :label="command.slug"
            :kind="command.script ? 'script' : 'command'"
            :rules="command.mcp"
            :actions="COMMAND_ACTIONS"
            :depth="2"
            :grant-id="`${section.slug}/${project.slug}/${command.slug}`"
            :granted="granted"
            :target="command.mcpTarget"
            :edit="edit"
          />
          <McpRulesRow
            v-for="files in project.files"
            :key="`${section.slug}/${project.slug}/files/${files.slug}`"
            :label="files.slug"
            kind="files"
            :rules="files.mcp"
            :actions="FILE_ACTIONS"
            :depth="2"
            :grant-id="`${section.slug}/${project.slug}/${files.slug}`"
            :granted="granted"
            :target="files.mcpTarget"
            :edit="edit"
          />
          <McpRulesRow
            v-for="integration in forgeIntegrations(project.integrations)"
            :key="`${section.slug}/${project.slug}/integrations/${integration.slug}`"
            :label="integration.slug"
            :kind="INTEGRATION_KINDS[integration.type]"
            :rules="integration.mcp"
            :actions="INTEGRATION_ACTIONS"
            :depth="2"
            :grant-id="integration.type"
            :granted="granted"
            :target="integration.mcpTarget"
            :edit="edit"
          />
        </template>
      </div>
    </CardContent>
  </Card>
</template>
