<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { Bookmark, FolderTree, Play, RotateCcw, Square } from "lucide-vue-next";
import SidebarStreamItem from "@/components/SidebarStreamItem.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import bookmarkStore from "@/stores/bookmark";
import configStore from "@/stores/config";
import wsStore from "@/stores/ws";
import type { CommandStream } from "@/types";

interface SidebarDirectory {
  slug: string;
  projectSlug: string;
  name: string;
  args: string[];
  env: Record<string, string>;
  notifications: boolean;
  stream: CommandStream | null;
  streams: CommandStream[];
  meta?: unknown;
}

interface SidebarProject {
  slug: string;
  name: string;
  directories: SidebarDirectory[];
  streams: CommandStream[];
}

const bookmarkedOnly = ref(false);
const appVersion = window.devtool?.version ?? "0.0.0";

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
          env: directory.env,
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
        directories,
        streams: [],
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

function startDirectoryCommand(directory: SidebarDirectory): void {
  if (directory.stream) {
    streamUpdate(directory.stream.slug, "start");
    return;
  }
  wsStore.newCommandStream(directory.projectSlug, directory.slug, true, directory.args, directory.env, directory.notifications);
}
</script>

<template>
  <aside class="flex h-full min-h-0 flex-col bg-card">
    <ScrollArea class="min-h-0 flex-1 px-3 py-3">
      <div class="flex flex-col gap-4">
        <RouterLink
          v-if="configStore.warnings.value.length"
          :to="{ name: 'dashboard' }"
          class="rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1.5 text-sm font-medium text-destructive"
        >
          {{ configStore.warnings.value.length }} config warning{{ configStore.warnings.value.length > 1 ? "s" : "" }}
        </RouterLink>

        <div class="flex items-center justify-between rounded-md bg-muted p-1">
          <Button
            size="sm"
            variant="ghost"
            class="h-8 w-full justify-start gap-2"
            :class="{ 'bg-background': bookmarkedOnly }"
            @click="bookmarkedOnly = !bookmarkedOnly"
          >
            <Bookmark class="size-4" />
            Bookmarks
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
          <RouterLink
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
                class="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent/60"
                :class="{
                  'bg-accent/60': directory.stream?.status === 'RUNNING',
                  'border border-destructive/40': directory.stream?.status === 'ERROR'
                }"
              >
                <span class="min-w-0 flex-1 truncate">{{ directory.name }}</span>
                <Badge
                  v-if="directory.stream?.unread"
                  variant="secondary"
                  class="h-5 px-1.5"
                >
                  •
                </Badge>
                <div class="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <Button
                    v-if="!directory.stream || directory.stream.status !== 'RUNNING'"
                    size="icon"
                    variant="ghost"
                    class="size-6"
                    @click.prevent.stop="startDirectoryCommand(directory)"
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
    <RouterLink
      :to="{ name: 'dashboard' }"
      class="px-3 py-2 text-center text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      Devtool <sup>{{ appVersion }}</sup>
    </RouterLink>
  </aside>
</template>
