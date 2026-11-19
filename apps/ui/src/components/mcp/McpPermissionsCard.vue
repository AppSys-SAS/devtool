<script setup lang="ts">
import { computed } from "vue";
import { MCP_ACTIONS, type McpAction, type McpLevel, type McpRules } from "@appsys/devtool-shared";
import McpRulesRow from "@/components/mcp/McpRulesRow.vue";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import configStore from "@/stores/config";
import mcpStore from "@/stores/mcp";

const COMMAND_ACTIONS: readonly McpAction[] = ["read", "run", "input", "control"];
const FILE_ACTIONS: readonly McpAction[] = ["read", "write"];
const CERTIFICATE_ACTIONS: readonly McpAction[] = ["read", "run"];

const settings = configStore.mcp;
const projects = computed(() => Object.values(configStore.projects.value ?? {}));
const granted = computed(() => new Set(mcpStore.state.value?.grants.filter((grant) => grant.scope === "always").map((grant) => grant.key)));

/**
 * Gives every action the same level, for a setting ruling some actions only.
 * @param level The level.
 * @param from The setting.
 * @returns The rules, the row showing only the actions the setting rules.
 */
function uniformRules(level: McpLevel, from: string): McpRules {
  return Object.fromEntries(MCP_ACTIONS.map((action) => [action, { level, from }])) as McpRules;
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
    <CardHeader>
      <CardTitle>Effective permissions</CardTitle>
      <CardDescription>The level of every action as the configuration resolves it. Hover a level to see where it comes from, ✓ marks a call granted always.</CardDescription>
    </CardHeader>
    <CardContent class="space-y-3">
      <div class="space-y-1">
        <McpRulesRow
          label="adt.mcp.default"
          kind="everything declaring nothing, terminals opened by you"
          :rules="settings.default"
          :actions="MCP_ACTIONS"
          :depth="0"
          :granted="granted"
        />
        <McpRulesRow
          label="adt.mcp.ownTerminals"
          kind="the terminals an agent started itself"
          :rules="ownTerminals"
          :actions="['input', 'control']"
          :depth="0"
          :granted="granted"
        />
        <McpRulesRow
          label="adt.mcp.shell"
          :kind="shellKind"
          :rules="shell"
          :actions="['run']"
          :depth="0"
          :granted="granted"
        />
        <McpRulesRow
          label="environment"
          kind="configs, pulls and pushes"
          :rules="settings.environment"
          :actions="['read', 'run', 'write']"
          :depth="0"
          :granted="granted"
        />
        <McpRulesRow
          v-for="(rules, name) in settings.certificates"
          :key="`certificate/${name}`"
          :label="name"
          kind="certificate"
          :rules="rules"
          :actions="CERTIFICATE_ACTIONS"
          :depth="0"
          :grant-id="`certificate:${name}`"
          :granted="granted"
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
          />
        </template>
      </div>
    </CardContent>
  </Card>
</template>
