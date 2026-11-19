<script setup lang="ts">
import { computed, shallowRef } from "vue";
import { Check, Pencil } from "@lucide/vue";
import { MCP_ACTIONS, type McpAction, type McpLevel, type McpRules } from "@appsys/devtool-shared";
import McpRulesRow from "@/components/mcp/McpRulesRow.vue";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { shortPath, type McpEditMode } from "@/lib/mcp";
import configStore from "@/stores/config";
import mcpStore from "@/stores/mcp";

const COMMAND_ACTIONS: readonly McpAction[] = ["read", "run", "input", "control"];
const FILE_ACTIONS: readonly McpAction[] = ["read", "write"];
const CERTIFICATE_ACTIONS: readonly McpAction[] = ["read", "run"];
const OWN_TERMINAL_LEVELS: readonly McpLevel[] = ["allow", "ask"];
const SHELL_LEVELS: readonly McpLevel[] = ["allow", "ask", "deny"];

const settings = configStore.mcp;
const projects = computed(() => Object.values(configStore.projects.value ?? {}));
const granted = computed(() => new Set(mcpStore.state.value?.grants.filter((grant) => grant.scope === "always").map((grant) => grant.key)));

const editFile = shallowRef<McpEditMode["file"] | null>(null);
const edit = computed<McpEditMode | null>(() => (editFile.value ? { file: editFile.value, localFile: settings.value?.localFile ?? null } : null));

/**
 * Enters the edit mode, writing to the personal override when there is one, or leaves it.
 */
function toggleEdit(): void {
  editFile.value = editFile.value ? null : settings.value?.localFile ? "local" : "declared";
}

/**
 * Gives every action the same level, for a setting ruling some actions only.
 * @param level The level.
 * @param from The setting.
 * @returns The rules, the row showing only the actions the setting rules.
 */
function uniformRules(level: McpLevel, from: string): McpRules {
  return Object.fromEntries(MCP_ACTIONS.map((action) => [action, { level, from }])) as McpRules;
}

/**
 * Names a folder of scripts by its own name.
 * @param folder The absolute path of the folder.
 * @returns Its name.
 */
function folderName(folder: string): string {
  return folder.split("/").slice(-1)[0] ?? folder;
}

const ownTerminals = computed(() => uniformRules(settings.value?.ownTerminals ?? "allow", "adt.mcp.ownTerminals"));
const shell = computed(() => uniformRules(settings.value?.shell.level ?? "deny", "adt.mcp.shell.level"));
const shellKind = computed(() => {
  const patterns = settings.value?.shell;
  return [
    "command lines outside the configuration",
    patterns?.allow.length ? `allow ${patterns.allow.join(", ")}` : null,
    patterns?.deny.length ? `deny ${patterns.deny.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
});
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
      <Button
        size="sm"
        :variant="edit ? 'default' : 'outline'"
        class="shrink-0 gap-1.5"
        @click="toggleEdit"
      >
        <Check
          v-if="edit"
          class="size-3.5"
        />
        <Pencil
          v-else
          class="size-3.5"
        />
        {{ edit ? "Done" : "Edit" }}
      </Button>
    </CardHeader>
    <CardContent class="space-y-3">
      <div
        v-if="edit"
        class="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-3 py-2 text-xs"
      >
        <span class="text-muted-foreground">Write changes to</span>
        <div class="flex rounded-md border bg-background p-0.5">
          <button
            v-for="option in [
              { file: 'local' as const, label: 'Personal', hint: settings.localFile ? shortPath(settings.localFile) : 'no personal override loaded' },
              { file: 'declared' as const, label: 'Shared', hint: 'the file declaring each setting' },
            ]"
            :key="option.file"
            type="button"
            :disabled="option.file === 'local' && !settings.localFile"
            :class="cn(
              'rounded px-2.5 py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              editFile === option.file ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
            )"
            :title="option.hint"
            @click="editFile = option.file"
          >
            {{ option.label }}
          </button>
        </div>
        <span class="text-muted-foreground">
          <template v-if="editFile === 'local'">
            <code>{{ settings.localFile ? shortPath(settings.localFile) : "" }}</code>, loaded last: it prevails over every other file, for you only.
          </template>
          <template v-else>
            Each row shows the file it changes, shared with the others once pushed or committed.
          </template>
        </span>
      </div>

      <div class="space-y-1">
        <McpRulesRow
          label="adt.mcp.default"
          kind="everything declaring nothing, terminals opened by you"
          :rules="settings.default"
          :actions="MCP_ACTIONS"
          :depth="0"
          :granted="granted"
          :target="settings.targets.default"
          :edit="edit"
        />
        <McpRulesRow
          label="adt.mcp.ownTerminals"
          kind="the terminals an agent started itself"
          :rules="ownTerminals"
          :actions="['input', 'control']"
          :depth="0"
          :granted="granted"
          :target="settings.targets.ownTerminals"
          :levels="OWN_TERMINAL_LEVELS"
          :edit="edit"
        />
        <McpRulesRow
          label="adt.mcp.shell"
          :kind="shellKind"
          :rules="shell"
          :actions="['run']"
          :depth="0"
          :granted="granted"
          :target="settings.targets.shell"
          :levels="SHELL_LEVELS"
          :edit="edit"
        />
        <McpRulesRow
          label="environment"
          kind="configs, pulls and pushes"
          :rules="settings.environment"
          :actions="['read', 'run', 'write']"
          :depth="0"
          :granted="granted"
          :target="settings.targets.environment"
          :edit="edit"
        />
        <McpRulesRow
          v-for="(certificate, name) in settings.certificates"
          :key="`certificate/${name}`"
          :label="name"
          kind="certificate"
          :rules="certificate.rules"
          :actions="CERTIFICATE_ACTIONS"
          :depth="0"
          :grant-id="`certificate:${name}`"
          :granted="granted"
          :target="certificate.target"
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
        </template>
      </div>
    </CardContent>
  </Card>
</template>
