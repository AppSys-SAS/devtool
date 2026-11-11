<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { useColorMode } from "@vueuse/core";
import { Icon } from "@iconify/vue";
import { ArrowDownUp, Bookmark, Circle, Download, FileCog, FolderOpen, FolderTree, FolderX, Monitor, Moon, Play, RefreshCw, RotateCcw, Square, Sun } from '@lucide/vue'
import CdnSession from "@/components/CdnSession.vue";
import SidebarStreamItem from "@/components/SidebarStreamItem.vue";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { ProjectRestore } from "@appsys/devtool-shared";
import { iconFromMeta, startDefaultCommand } from "@/lib/directory-commands";
import bookmarkStore from "@/stores/bookmark";
import commandRunsStore from "@/stores/command-runs";
import configStore from "@/stores/config";
import wsStore from "@/stores/ws";
import type { CommandStream } from "@/types";

interface SidebarDirectory {
  slug: string;
  projectSlug: string;
  name: string;
  args: string[] | null;
  defaultFiles: { slug: string; name: string } | null;
  env: Record<string, string>;
  extras: Record<string, { name: string; args: string[]; killSignal: string | null; meta?: unknown }>;
  killSignal: string | null;
  notifications: boolean;
  stream: CommandStream | null;
  streams: CommandStream[];
  meta?: unknown;
}

interface SidebarProject {
  slug: string;
  name: string;
  missing: boolean;
  restore: ProjectRestore | null;
  directories: SidebarDirectory[];
  streams: CommandStream[];
  meta?: unknown;
}

const router = useRouter();
const bookmarkedOnly = ref(false);
const appVersion = window.devtool?.version ?? "0.0.0";
const colorMode = useColorMode({
  emitAuto: true,
  storageKey: "devtool-color-mode",
});

const colorModeLabel = computed(() => {
  if (colorMode.value === "dark") {
    return "Dark";
  }
  if (colorMode.value === "light") {
    return "Light";
  }
  return "Auto";
});

function toggleColorMode(): void {
  if (colorMode.value === "auto") {
    colorMode.value = "light";
    return;
  }
  if (colorMode.value === "light") {
    colorMode.value = "dark";
    return;
  }
  colorMode.value = "auto";
}

watch(
  () => bookmarkStore.slugs.value.length,
  (length) => {
    if (length > 0) {
      bookmarkedOnly.value = true;
    }
  },
  { immediate: true },
);

const allStreams = computed(() => configStore.commandStreams.value);

const sidebarData = computed(() => {
  const projects: SidebarProject[] = [];
  const global: CommandStream[] = [];
  const usedStreamSlugs = new Set<string>();
  const configProjects = configStore.projects.value;

  if (configProjects) {
    for (const [projectSlug, project] of Object.entries(configProjects)) {
      const directories: SidebarDirectory[] = [];

      for (const [directorySlug, directory] of Object.entries(project.directories)) {
        const directoryItem: SidebarDirectory = {
          slug: directorySlug,
          projectSlug,
          name: directory.name || directorySlug,
          args: directory.args,
          defaultFiles: directory.defaultFiles ? { slug: directory.defaultFiles, name: directory.files[directory.defaultFiles]?.name ?? directory.defaultFiles } : null,
          env: directory.env,
          killSignal: directory.killSignal,
          extras: directory.extras,
          notifications: directory.notifications,
          stream: null,
          streams: [],
          meta: directory.meta,
        };

        for (const stream of allStreams.value) {
          if (stream.projectSlug === projectSlug && stream.directorySlug === directorySlug) {
            usedStreamSlugs.add(stream.slug);
            if (stream.primary) {
              directoryItem.stream = stream;
            } else {
              directoryItem.streams.push(stream);
            }
          }
        }

        directories.push(directoryItem);
      }

      const projectItem: SidebarProject = {
        slug: projectSlug,
        name: project.name || projectSlug,
        missing: project.missing,
        restore: project.restore,
        directories,
        streams: [],
        meta: project.meta,
      };

      for (const stream of allStreams.value) {
        if (stream.projectSlug === projectSlug && stream.directorySlug === null) {
          usedStreamSlugs.add(stream.slug);
          projectItem.streams.push(stream);
        }
      }

      projects.push(projectItem);
    }
  }

  for (const stream of allStreams.value) {
    if (!usedStreamSlugs.has(stream.slug)) {
      global.push(stream);
    }
  }

  return {
    globalStreams: global,
    allProjects: projects,
  };
});

const globalStreams = computed(() => sidebarData.value.globalStreams);
const allProjects = computed(() => sidebarData.value.allProjects);

const projects = computed(() => {
  if (!bookmarkedOnly.value) {
    return allProjects.value;
  }

  const bookmarks = new Set(bookmarkStore.slugs.value);
  const filtered: SidebarProject[] = [];

  for (const project of allProjects.value) {
    const directories = project.directories.filter((directory) => {
      const slug = `${project.slug}/${directory.slug}`;
      return Boolean(directory.stream) || directory.streams.length > 0 || bookmarks.has(slug);
    });

    if (directories.length > 0 || project.streams.length > 0) {
      filtered.push({
        ...project,
        directories,
      });
    }
  }

  return filtered;
});

function streamUpdate(streamSlug: string, action: "start" | "stop" | "restart" | "close"): void {
  wsStore.updateCommandStream(streamSlug, action);
}

/**
 * Brings back the missing folder of a project in the background, its questions in a dialog, then
 * reloads the configuration so the project shows.
 * @param project The missing project.
 */
function restoreProject(project: SidebarProject): void {
  if (!project.restore) {
    return;
  }

  commandRunsStore.start({
    projectSlug: project.slug,
    directorySlug: null,
    args: project.restore.args,
    env: {},
    killSignal: null,
    notifications: true,
    name: `${project.restore.name} ${project.name}`,
    restore: true,
    onFinished: () => wsStore.reconfigure(),
  });
}

/**
 * Opens the folder of files a directory opens by default.
 * @param directory The directory.
 */
function openDefaultFiles(directory: SidebarDirectory): void {
  if (directory.defaultFiles) {
    void router.push({ name: "directory-files", params: { projectSlug: directory.projectSlug, directorySlug: directory.slug, fileSpace: directory.defaultFiles.slug } });
  }
}

function areArgsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function resolveStreamIcon(directory: SidebarDirectory, stream: CommandStream): string {
  const extras = Object.values(directory.extras);
  for (const extra of extras) {
    if (extra.name === stream.name && areArgsEqual(extra.args, stream.args)) {
      return iconFromMeta(extra.meta);
    }
  }

  for (const extra of extras) {
    if (areArgsEqual(extra.args, stream.args)) {
      return iconFromMeta(extra.meta);
    }
  }

  for (const extra of extras) {
    if (extra.name === stream.name) {
      return iconFromMeta(extra.meta);
    }
  }

  return iconFromMeta(directory.meta);
}
</script>

<template>
  <aside class="flex h-full min-h-0 flex-col bg-card">
    <ScrollArea class="min-h-0 flex-1">
      <div class="flex flex-col gap-4 px-3 py-3">
        <RouterLink
          v-if="configStore.warnings.value.length"
          :to="{ name: 'dashboard' }"
          class="rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1.5 text-sm font-medium text-destructive"
        >
          {{ configStore.warnings.value.length }} config warning{{ configStore.warnings.value.length > 1 ? "s" : "" }}
        </RouterLink>

        <div class="flex items-center gap-1 rounded-md p-1">
          <Button
            as-child
            size="sm"
            variant="ghost"
            class="h-8 flex-1 justify-start gap-2"
          >
            <RouterLink :to="{ name: 'environment' }">
              <ArrowDownUp class="size-4" />
              Environment
            </RouterLink>
          </Button>
          <Button
            as-child
            size="sm"
            variant="ghost"
            class="h-8 flex-1 justify-start gap-2"
          >
            <RouterLink :to="{ name: 'configs' }">
              <FileCog class="size-4" />
              Configs
            </RouterLink>
          </Button>
        </div>

        <p
          v-if="bookmarkedOnly && bookmarkStore.slugs.value.length === 0"
          class="text-xs text-muted-foreground"
        >
          Set bookmarks from directory sidebars.
        </p>

        <div
          v-for="stream in globalStreams"
          :key="`global/${stream.slug}`"
          class="space-y-1"
        >
          <SidebarStreamItem
            :stream="stream"
            :label="stream.name"
            icon="ph:terminal"
            :route="{ name: 'stream', params: { streamSlug: stream.slug } }"
            @start="streamUpdate($event, 'start')"
            @stop="streamUpdate($event, 'stop')"
            @restart="streamUpdate($event, 'restart')"
            @close="streamUpdate($event, 'close')"
          />
        </div>

        <div
          v-for="project in projects"
          :key="`project/${project.slug}`"
          class="space-y-2"
        >
          <div
            v-if="project.missing"
            class="flex items-center gap-2 rounded-md px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground/60"
            title="Missing on this machine"
          >
            <FolderX class="size-3.5" />
            <span class="min-w-0 flex-1 truncate">{{ project.name }}</span>
            <Button
              v-if="project.restore"
              size="sm"
              variant="outline"
              class="h-6 gap-1 px-2 text-[11px] normal-case tracking-normal"
              @click="restoreProject(project)"
            >
              <Download class="size-3" />
              {{ project.restore.name }}
            </Button>
          </div>
          <RouterLink
            v-else
            :to="{ name: 'project', params: { projectSlug: project.slug } }"
            class="flex items-center gap-2 rounded-md px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent/50"
          >
            <FolderTree class="size-3.5" />
            {{ project.name }}
          </RouterLink>

          <div class="space-y-1 pl-2">
            <SidebarStreamItem
              v-for="stream in project.streams"
              :key="`project/${project.slug}/stream/${stream.slug}`"
              :stream="stream"
              :label="stream.name"
              :route="{ name: 'project-stream', params: { projectSlug: project.slug, streamSlug: stream.slug } }"
              @start="streamUpdate($event, 'start')"
              @stop="streamUpdate($event, 'stop')"
              @restart="streamUpdate($event, 'restart')"
              @close="streamUpdate($event, 'close')"
            />

            <div
              v-for="directory in project.directories"
              :key="`project/${project.slug}/directory/${directory.slug}`"
              class="space-y-1"
            >
              <RouterLink
                :to="{ name: 'directory', params: { projectSlug: project.slug, directorySlug: directory.slug } }"
                class="group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent/60"
                :class="{
                  'bg-accent/60': directory.stream?.status === 'RUNNING',
                  'border border-destructive/40': directory.stream?.status === 'ERROR',
                  'border border-valid/40': directory.stream?.status === 'STOPPED'
                }"
              >
                <span
                  v-if="directory.stream?.unread"
                  class="pointer-events-none absolute -right-0.5 -top-0.5 z-[100]"
                >
                  <span class="relative flex size-3">
                    <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75"></span>
                    <span class="relative inline-flex size-3 rounded-full bg-sky-500"></span>
                  </span>
                </span>
                <Icon
                  :icon="iconFromMeta(directory.meta, 'lucide:folder-tree')"
                  class="size-3.5 shrink-0 text-muted-foreground"
                />
                <span class="min-w-0 flex-1 truncate">{{ directory.name }}</span>
                <div class="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <Button
                    v-if="directory.defaultFiles"
                    size="icon"
                    variant="ghost"
                    class="size-6"
                    :title="directory.defaultFiles.name"
                    @click.prevent.stop="openDefaultFiles(directory)"
                  >
                    <FolderOpen class="size-3.5" />
                  </Button>
                  <Button
                    v-if="(directory.args || directory.stream) && directory.stream?.status !== 'RUNNING'"
                    size="icon"
                    variant="ghost"
                    class="size-6"
                    @click.prevent.stop="startDefaultCommand(directory.projectSlug, directory)"
                  >
                    <Play class="size-3.5" />
                  </Button>
                  <Button
                    v-if="directory.stream && directory.stream.status === 'RUNNING'"
                    size="icon"
                    variant="ghost"
                    class="size-6"
                    @click.prevent.stop="streamUpdate(directory.stream.slug, 'stop')"
                  >
                    <Square class="size-3.5" />
                  </Button>
                  <Button
                    v-if="directory.stream && directory.stream.status === 'RUNNING'"
                    size="icon"
                    variant="ghost"
                    class="size-6"
                    @click.prevent.stop="streamUpdate(directory.stream.slug, 'restart')"
                  >
                    <RotateCcw class="size-3.5" />
                  </Button>
                </div>
              </RouterLink>

              <div class="space-y-1 pl-2">
                <SidebarStreamItem
                  v-for="stream in directory.streams"
                  :key="`project/${project.slug}/directory/${directory.slug}/stream/${stream.slug}`"
                  :stream="stream"
                  :label="stream.name"
                  :icon="resolveStreamIcon(directory, stream)"
                  :route="{
                    name: 'directory-stream',
                    params: { projectSlug: project.slug, directorySlug: directory.slug, streamSlug: stream.slug }
                  }"
                  @start="streamUpdate($event, 'start')"
                  @stop="streamUpdate($event, 'stop')"
                  @restart="streamUpdate($event, 'restart')"
                  @close="streamUpdate($event, 'close')"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </ScrollArea>
    <Separator />
    <CdnSession />
    <div class="flex items-center justify-between gap-2 px-3 py-2">
      <RouterLink
        :to="{ name: 'dashboard' }"
        class="min-w-0 truncate text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        AppSys Devtool <sup>{{ appVersion }}</sup>
      </RouterLink>

      <Button
        size="icon"
        variant="ghost"
        class="ml-auto size-8 shrink-0"
        title="Bookmarks only"
        @click="bookmarkedOnly = !bookmarkedOnly"
      >
        <Bookmark
          class="size-3.5"
          :class="{ 'fill-current': bookmarkedOnly }"
        />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        class="size-8 shrink-0"
        @click="wsStore.reconfigure()"
      >
        <RefreshCw class="size-3.5" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        class="h-8 shrink-0 gap-1.5 px-2 text-xs"
        @click="toggleColorMode"
      >
        <Monitor
          v-if="colorMode === 'auto'"
          class="size-3.5"
        />
        <Sun
          v-else-if="colorMode === 'light'"
          class="size-3.5"
        />
        <Moon
          v-else
          class="size-3.5"
        />
        {{ colorModeLabel }}
      </Button>
    </div>
  </aside>
</template>
