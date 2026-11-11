<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { Icon } from "@iconify/vue";
import { FolderOpen, FolderTree, Globe, Play, RotateCcw, ScrollText, Square } from "@lucide/vue";
import type { DirectoryDefinition, HostAccess } from "@appsys/devtool-shared";
import SummaryRow from "@/components/project/SummaryRow.vue";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { useDirectoryScripts } from "@/composables/useDirectoryScripts";
import { commandName, iconFromMeta, runDirectoryCommand, startDefaultCommand } from "@/lib/directory-commands";
import { cn } from "@/lib/utils";
import configStore from "@/stores/config";
import wsStore from "@/stores/ws";
import type { CommandStreamStatus } from "@/types";

const props = defineProps<{
  projectSlug: string;
  directory: DirectoryDefinition;
}>();

const CHIP = "inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent/60";
const STATUS_DOT: Record<CommandStreamStatus, string> = {
  RUNNING: "bg-valid",
  STOPPED: "bg-muted-foreground/40",
  ERROR: "bg-destructive",
};

const streams = computed(() =>
  configStore.commandStreams.value.filter((stream) => stream.projectSlug === props.projectSlug && stream.directorySlug === props.directory.slug),
);
const primary = computed(() => streams.value.find((stream) => stream.primary) ?? null);
const terminals = computed(() => streams.value.filter((stream) => !stream.primary));
const commands = computed(() => Object.values(props.directory.extras));
const files = computed(() => Object.values(props.directory.files));
const scripts = useDirectoryScripts(() => props.projectSlug, () => props.directory);

const services = computed(() => {
  const hosts = new Map<string, HostAccess>();
  for (const rule of Object.values(props.directory.loadBalancer)) {
    for (const host of rule.hosts) {
      if (hosts.get(host) !== "network") {
        hosts.set(host, rule.access);
      }
    }
  }

  return [...hosts].map(([host, access]) => ({ host, access }));
});

const directoryRoute = computed(() => ({ name: "directory", params: { projectSlug: props.projectSlug, directorySlug: props.directory.slug } }));
</script>

<template>
  <Card class="gap-4 py-4">
    <CardHeader class="gap-1 px-4">
      <div class="flex items-center gap-2">
        <Icon
          :icon="iconFromMeta(directory.meta, 'lucide:folder-tree')"
          class="size-4 shrink-0 text-muted-foreground"
        />
        <RouterLink
          :to="directoryRoute"
          class="min-w-0 flex-1 truncate font-semibold hover:underline"
        >
          {{ directory.name }}
        </RouterLink>
        <span
          v-if="primary"
          class="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <span :class="cn('size-2 rounded-full', STATUS_DOT[primary.status])" />
          {{ primary.status.toLowerCase() }}
        </span>
        <Button
          v-if="directory.defaultFiles"
          as-child
          size="icon"
          variant="ghost"
          class="size-7"
          :title="directory.files[directory.defaultFiles]?.name"
        >
          <RouterLink :to="{ name: 'directory-files', params: { projectSlug, directorySlug: directory.slug, fileSpace: directory.defaultFiles } }">
            <FolderOpen class="size-3.5" />
          </RouterLink>
        </Button>
        <template v-if="primary?.status === 'RUNNING'">
          <Button
            size="icon"
            variant="ghost"
            class="size-7"
            title="Stop"
            @click="wsStore.updateCommandStream(primary.slug, 'stop')"
          >
            <Square class="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            class="size-7"
            title="Restart"
            @click="wsStore.updateCommandStream(primary.slug, 'restart')"
          >
            <RotateCcw class="size-3.5" />
          </Button>
        </template>
        <Button
          v-else-if="directory.args || primary"
          size="icon"
          variant="ghost"
          class="size-7"
          :title="directory.args?.join(' ')"
          @click="startDefaultCommand(projectSlug, directory)"
        >
          <Play class="size-3.5" />
        </Button>
      </div>
      <CardDescription
        v-if="directory.description"
        class="line-clamp-2"
      >
        {{ directory.description }}
      </CardDescription>
    </CardHeader>

    <CardContent
      v-if="commands.length || terminals.length || files.length || directory.scripts.length || services.length"
      class="space-y-3 px-4"
    >
      <SummaryRow
        v-if="commands.length"
        label="Commands"
      >
        <button
          v-for="command in commands"
          :key="command.slug"
          type="button"
          :class="CHIP"
          :title="command.args.join(' ')"
          @click="runDirectoryCommand(projectSlug, directory.slug, command)"
        >
          <Icon
            :icon="iconFromMeta(command.meta)"
            class="size-3.5 shrink-0 text-muted-foreground"
          />
          <span class="truncate">{{ commandName(command) }}</span>
        </button>
      </SummaryRow>

      <SummaryRow
        v-if="terminals.length"
        label="Terminals"
      >
        <RouterLink
          v-for="stream in terminals"
          :key="stream.slug"
          :to="{ name: 'directory-stream', params: { projectSlug, directorySlug: directory.slug, streamSlug: stream.slug } }"
          :class="CHIP"
        >
          <span :class="cn('size-2 shrink-0 rounded-full', STATUS_DOT[stream.status])" />
          <span class="truncate">{{ stream.name }}</span>
        </RouterLink>
      </SummaryRow>

      <SummaryRow
        v-if="files.length || directory.scripts.length"
        label="Files"
      >
        <RouterLink
          v-for="space in files"
          :key="space.slug"
          :to="{ name: 'directory-files', params: { projectSlug, directorySlug: directory.slug, fileSpace: space.slug } }"
          :class="CHIP"
          :title="space.path"
        >
          <FolderTree class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="truncate">{{ space.name }}</span>
        </RouterLink>
        <RouterLink
          v-if="directory.scripts.length"
          :to="directoryRoute"
          :class="CHIP"
          :title="directory.scripts.map((folder) => folder.path).join(', ')"
        >
          <ScrollText class="size-3.5 shrink-0 text-muted-foreground" />
          <span v-if="scripts?.error" class="text-destructive">Scripts unavailable</span>
          <span v-else>{{ scripts ? scripts.scripts.length : "…" }} scripts</span>
        </RouterLink>
      </SummaryRow>

      <SummaryRow
        v-if="services.length"
        label="Services"
      >
        <a
          v-for="service in services"
          :key="service.host"
          :href="`https://${service.host}`"
          target="_blank"
          rel="noopener"
          :class="CHIP"
        >
          <Globe class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="truncate">{{ service.host }}</span>
          <span
            :class="cn('rounded px-1 text-[10px] uppercase', service.access === 'network' ? 'bg-valid/15 text-valid' : 'bg-muted text-muted-foreground')"
            :title="service.access === 'network' ? 'Reachable from the network' : 'Reachable from this machine only'"
          >{{ service.access }}</span>
        </a>
      </SummaryRow>
    </CardContent>
  </Card>
</template>
