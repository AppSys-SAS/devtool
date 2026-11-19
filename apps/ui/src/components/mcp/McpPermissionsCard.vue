<script setup lang="ts">
import { computed, shallowRef } from "vue";
import { ChevronRight } from "@lucide/vue";
import { MCP_ACTIONS, type McpAction } from "@appsys/devtool-shared";
import McpRulesRow from "@/components/mcp/McpRulesRow.vue";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LEVELS } from "@/lib/mcp";
import configStore from "@/stores/config";
import mcpStore from "@/stores/mcp";

const COMMAND_ACTIONS: readonly McpAction[] = ["read", "run", "input", "control"];
const FILE_ACTIONS: readonly McpAction[] = ["read", "write"];
const CERTIFICATE_ACTIONS: readonly McpAction[] = ["read", "run"];

const open = shallowRef(false);
const settings = configStore.mcp;
const projects = computed(() => Object.values(configStore.projects.value ?? {}));
const granted = computed(() => new Set(mcpStore.state.value?.grants.filter((grant) => grant.scope === "always").map((grant) => grant.key)));
</script>

<template>
  <Card v-if="settings">
    <CardHeader>
      <button
        type="button"
        class="flex items-center gap-2 text-left"
        @click="open = !open"
      >
        <ChevronRight
          class="size-4 text-muted-foreground transition-transform"
          :class="{ 'rotate-90': open }"
        />
        <div class="space-y-1.5">
          <CardTitle>Effective permissions</CardTitle>
          <CardDescription>The level of every action as the configuration resolves it; hover a level to see where it comes from. ✓ marks a call granted always.</CardDescription>
        </div>
      </button>
    </CardHeader>
    <CardContent
      v-if="open"
      class="space-y-3"
    >
      <div class="space-y-1">
        <McpRulesRow
          label="adt.mcp.default"
          kind="everything declaring nothing, terminals opened by you"
          :rules="settings.default"
          :actions="MCP_ACTIONS"
          :depth="0"
          :granted="granted"
        />
        <div class="flex flex-wrap items-center gap-2 px-2 py-1 text-xs">
          <span class="min-w-0 flex-1"><span class="font-mono">adt.mcp.ownTerminals</span> <span class="text-muted-foreground">typing into and controlling the terminals of agents</span></span>
          <Badge :class="LEVELS[settings.ownTerminals]">
            {{ settings.ownTerminals }}
          </Badge>
        </div>
        <div class="flex flex-wrap items-center gap-2 px-2 py-1 text-xs">
          <span class="min-w-0 flex-1"><span class="font-mono">adt.mcp.shell</span> <span class="text-muted-foreground">command lines outside the configuration</span></span>
          <code
            v-if="settings.shell.allow.length"
            class="text-emerald-700 dark:text-emerald-300"
          >allow {{ settings.shell.allow.join(", ") }}</code>
          <code
            v-if="settings.shell.deny.length"
            class="text-destructive"
          >deny {{ settings.shell.deny.join(", ") }}</code>
          <Badge :class="LEVELS[settings.shell.level]">
            {{ settings.shell.level }}
          </Badge>
        </div>
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
