<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useColorMode } from '@vueuse/core'
import { Icon } from '@iconify/vue'
import { ArrowDownUp, Bookmark, Bot, Circle, Download, FileCog, FolderTree, FolderX, Monitor, Moon, Play, RefreshCw, RotateCcw, Square, Sun } from '@lucide/vue'
import CdnSession from '@/components/CdnSession.vue'
import SidebarStreamItem from '@/components/SidebarStreamItem.vue'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import type { CommandArg, DirectoryDefaultAction, DirectoryDefinition, ProjectRestore } from '@appsys/devtool-shared'
import ShortcutLine from '@/components/ShortcutLine.vue'
import { defaultShortcut, directoryShortcuts, integrationShortcut, projectShortcuts, type SidebarShortcut } from '@/lib/shortcuts'
import { iconFromMeta, startSection, stopSection } from '@/lib/directory-commands'
import bookmarkStore from '@/stores/bookmark'
import commandRunsStore from '@/stores/command-runs'
import configStore from '@/stores/config'
import mcpStore from '@/stores/mcp'
import wsStore from '@/stores/ws'
import type { CommandStream } from '@/types'

interface SidebarDirectory {
  slug: string
  projectSlug: string
  name: string
  args: CommandArg[] | null
  /** What the directory does by default, `command` telling whether it is its main command. */
  defaultAction: { shortcut: SidebarShortcut, trigger: DirectoryDefaultAction['trigger'], command: boolean } | null
  /** Shortcuts shown as icons in the row of the directory. */
  icons: SidebarShortcut[]
  /** Shortcuts shown as rows under the row of the directory. */
  lines: SidebarShortcut[]
  env: Record<string, string>
  extras: Record<string, { name: string, args: CommandArg[], killSignal: string | null, meta?: unknown }>
  killSignal: string | null
  notifications: boolean
  stream: CommandStream | null
  streams: CommandStream[]
  /** Whether the folder of the directory is missing on this machine. */
  missing: boolean
  restore: ProjectRestore | null
  meta?: unknown
}

/** A row under the header of a project: one of its own shortcuts, or one of its directories. */
type SidebarContent = { key: string, line: SidebarShortcut, directory?: undefined } | { key: string, line?: undefined, directory: SidebarDirectory }

interface SidebarProject {
  slug: string
  name: string
  missing: boolean
  restore: ProjectRestore | null
  directories: SidebarDirectory[]
  /** Shortcuts shown as icons in the header of the project. */
  icons: SidebarShortcut[]
  /** Its shortcuts shown as rows and its directories, in the order shown. */
  content: SidebarContent[]
  streams: CommandStream[]
  /** Whether a command of the section starts with it. */
  startable: boolean
  /** Whether a command of the section runs. */
  running: boolean
  meta?: unknown
}

const router = useRouter()
const route = useRoute()
const mcpWaiting = computed(() => mcpStore.state.value?.pending.length ?? 0)
const bookmarkedOnly = ref(false)
const appVersion = window.devtool?.version ?? '0.0.0'
const colorMode = useColorMode({
  emitAuto: true,
  storageKey: 'devtool-color-mode'
})

const colorModeLabel = computed(() => {
  if (colorMode.value === 'dark') {
    return 'Dark'
  }
  if (colorMode.value === 'light') {
    return 'Light'
  }
  return 'Auto'
})

function toggleColorMode (): void {
  if (colorMode.value === 'auto') {
    colorMode.value = 'light'
    return
  }
  if (colorMode.value === 'light') {
    colorMode.value = 'dark'
    return
  }
  colorMode.value = 'auto'
}

watch(
  () => bookmarkStore.slugs.value.length,
  length => {
    if (length > 0) {
      bookmarkedOnly.value = true
    }
  },
  { immediate: true }
)

const allStreams = computed(() => configStore.commandStreams.value)
const sidebarSettings = computed(() => configStore.sidebar.value)

const sidebarData = computed(() => {
  const projects: SidebarProject[] = []
  const global: CommandStream[] = []
  const usedStreamSlugs = new Set<string>()
  const configProjects = configStore.projects.value

  if (configProjects) {
    for (const project of configStore.sidebar.value.sections.flatMap(slug => configProjects[slug] ?? [])) {
      const projectSlug = project.slug
      const directories: SidebarDirectory[] = []

      for (const [directorySlug, directory] of Object.entries(project.directories)) {
        const directoryItem: SidebarDirectory = {
          slug: directorySlug,
          projectSlug,
          name: directory.name || directorySlug,
          args: directory.args,
          defaultAction: readDefaultAction(projectSlug, directory),
          icons: directoryShortcuts(projectSlug, directory, directory.icons),
          lines: directoryShortcuts(projectSlug, directory, directory.lines),
          env: directory.env,
          killSignal: directory.killSignal,
          extras: directory.extras,
          notifications: directory.notifications,
          stream: null,
          streams: [],
          missing: directory.missing,
          restore: directory.restore,
          meta: directory.meta
        }

        for (const stream of allStreams.value) {
          if (stream.projectSlug === projectSlug && stream.directorySlug === directorySlug) {
            usedStreamSlugs.add(stream.slug)
            if (stream.primary) {
              directoryItem.stream = stream
            } else {
              directoryItem.streams.push(stream)
            }
          }
        }

        directories.push(directoryItem)
      }

      const projectItem: SidebarProject = {
        slug: projectSlug,
        name: project.name || projectSlug,
        missing: project.missing,
        restore: project.restore,
        directories,
        icons: projectShortcuts(project, project.icons),
        content: projectContent(project.content, projectShortcuts(project, project.lines), directories),
        streams: [],
        startable: Object.values(project.directories).some(directory => Object.values(directory.extras).some(command => command.startWithSection)),
        running: allStreams.value.some(stream => stream.projectSlug === projectSlug && stream.status === 'RUNNING'),
        meta: project.meta
      }

      for (const stream of allStreams.value) {
        if (stream.projectSlug === projectSlug && stream.directorySlug === null) {
          usedStreamSlugs.add(stream.slug)
          projectItem.streams.push(stream)
        }
      }

      projects.push(projectItem)
    }
  }

  for (const stream of allStreams.value) {
    if (!usedStreamSlugs.has(stream.slug)) {
      global.push(stream)
    }
  }

  return {
    globalStreams: global,
    allProjects: projects
  }
})

const globalStreams = computed(() => sidebarData.value.globalStreams)
const allProjects = computed(() => sidebarData.value.allProjects)

const projects = computed(() => {
  if (!bookmarkedOnly.value) {
    return allProjects.value
  }

  const bookmarks = new Set(bookmarkStore.slugs.value)
  const filtered: SidebarProject[] = []

  for (const project of allProjects.value) {
    const directories = project.directories.filter(directory => {
      const slug = `${project.slug}/${directory.slug}`
      return Boolean(directory.stream) || directory.streams.length > 0 || bookmarks.has(slug)
    })
    const content = project.content.filter(item => item.line !== undefined || directories.includes(item.directory))

    if (content.length > 0 || project.streams.length > 0) {
      filtered.push({
        ...project,
        directories,
        content
      })
    }
  }

  return filtered
})

/**
 * Lists the rows under the header of a project in the order the server gives.
 * @param order Its shortcuts and directories in order, a shortcut by `<type>:<slug>`, a directory by its slug.
 * @param lines Its shortcuts shown as rows.
 * @param directories Its directories.
 * @returns The rows, without the keys naming nothing.
 */
function projectContent (order: string[], lines: SidebarShortcut[], directories: SidebarDirectory[]): SidebarContent[] {
  return order.flatMap((key): SidebarContent[] => {
    const line = lines.find(shortcut => shortcut.key === key)
    if (line) {
      return [{ key: `line/${key}`, line }]
    }
    const directory = directories.find(item => item.slug === key)
    return directory ? [{ key: `directory/${key}`, directory }] : []
  })
}

function streamUpdate (streamSlug: string, action: 'start' | 'stop' | 'restart' | 'close'): void {
  wsStore.updateCommandStream(streamSlug, action)
}

/**
 * Starts the commands of a section that start with it.
 * @param projectSlug The slug of the section.
 */
function startProject (projectSlug: string): void {
  const project = configStore.projects.value?.[projectSlug]
  if (project) {
    startSection(project)
  }
}

/**
 * Brings back the missing folder of a project or of one of its directories in the background, its
 * questions in a dialog, then reloads the configuration so it shows.
 * @param projectSlug The project.
 * @param directorySlug The missing directory, null for the missing project itself.
 * @param name The name of what is missing.
 * @param restore The command bringing the folder back.
 */
function restoreFolder (projectSlug: string, directorySlug: string | null, name: string, restore: ProjectRestore): void {
  commandRunsStore.start({
    projectSlug,
    directorySlug,
    args: restore.args,
    env: {},
    killSignal: null,
    notifications: true,
    name: `${restore.name} ${name}`,
    restore: true,
    onFinished: () => wsStore.reconfigure()
  })
}

/**
 * Gives what a directory of the sidebar does by default.
 * @param projectSlug The project of the directory.
 * @param directory The directory.
 * @returns Its default action, null when it declares none.
 */
function readDefaultAction (projectSlug: string, directory: DirectoryDefinition): SidebarDirectory['defaultAction'] {
  const shortcut = defaultShortcut(projectSlug, directory)
  if (!shortcut || !directory.defaultAction) {
    return null
  }
  return { shortcut, trigger: directory.defaultAction.trigger, command: directory.defaultAction.shortcut.type === 'command' }
}

/**
 * Runs the default action of a directory on a click on its row, when it is triggered from the row,
 * the row then not opening the directory; a main command already running opens the directory as usual.
 * @param event The click, its buttons keeping their own action.
 * @param directory The directory.
 */
function runDefaultActionFromRow (event: MouseEvent, directory: SidebarDirectory): void {
  const action = directory.defaultAction
  if (!action || action.trigger === 'icon' || (event.target as Element).closest('button') || (action.command && directory.stream?.status === 'RUNNING')) {
    return
  }
  event.preventDefault()
  action.shortcut.open()
}

/**
 * Compares the arguments of a command with those a stream runs.
 * @param left The arguments of the command, an input never matching.
 * @param right The arguments of the stream.
 * @returns True when both hold the same arguments.
 */
function areArgsEqual (left: CommandArg[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false
    }
  }

  return true
}

function resolveStreamIcon (directory: SidebarDirectory, stream: CommandStream): string {
  const extras = Object.values(directory.extras)
  for (const extra of extras) {
    if (extra.name === stream.name && areArgsEqual(extra.args, stream.args)) {
      return iconFromMeta(extra.meta)
    }
  }

  for (const extra of extras) {
    if (areArgsEqual(extra.args, stream.args)) {
      return iconFromMeta(extra.meta)
    }
  }

  for (const extra of extras) {
    if (extra.name === stream.name) {
      return iconFromMeta(extra.meta)
    }
  }

  return iconFromMeta(directory.meta)
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

        <div class="space-y-1">
          <div
            v-if="sidebarSettings.environment || sidebarSettings.configs"
            class="flex items-center gap-1 rounded-md p-1"
          >
            <Button
              v-if="sidebarSettings.environment"
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
              v-if="sidebarSettings.configs"
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

          <div
            v-if="configStore.integrations.value.length"
            class="space-y-1 px-1"
          >
            <ShortcutLine
              v-for="integration in configStore.integrations.value"
              :key="integration.slug"
              :shortcut="integrationShortcut(integration)"
            />
          </div>
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
              @click="restoreFolder(project.slug, null, project.name, project.restore)"
            >
              <Download class="size-3" />
              {{ project.restore.name }}
            </Button>
          </div>
          <RouterLink
            v-else
            :to="{ name: 'project', params: { projectSlug: project.slug } }"
            class="group flex items-center gap-2 rounded-md px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent/50"
          >
            <FolderTree class="size-3.5" />
            <span class="min-w-0 flex-1 truncate">{{ project.name }}</span>
            <div class="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <Button
                v-if="project.startable"
                size="icon"
                variant="ghost"
                class="size-5"
                title="Start the section"
                @click.prevent.stop="startProject(project.slug)"
              >
                <Play class="size-3" />
              </Button>
              <Button
                v-if="project.running"
                size="icon"
                variant="ghost"
                class="size-5"
                title="Stop the section"
                @click.prevent.stop="stopSection(project.slug)"
              >
                <Square class="size-3" />
              </Button>
            </div>
            <ShortcutLine
              v-for="shortcut in project.icons"
              :key="shortcut.key"
              :shortcut="shortcut"
              compact
            />
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

            <template
              v-for="{ key, line, directory } in project.content"
              :key="`project/${project.slug}/${key}`"
            >
              <ShortcutLine
                v-if="line"
                :shortcut="line"
              />
              <div
                v-else-if="directory"
                class="space-y-1"
              >
                <div
                  v-if="directory.missing"
                  class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground/60"
                  title="Missing on this machine"
                >
                  <FolderX class="size-3.5 shrink-0" />
                  <span class="min-w-0 flex-1 truncate">{{ directory.name }}</span>
                  <Button
                    v-if="directory.restore"
                    size="sm"
                    variant="outline"
                    class="h-6 gap-1 px-2 text-[11px]"
                    @click="restoreFolder(project.slug, directory.slug, directory.name, directory.restore)"
                  >
                    <Download class="size-3" />
                    {{ directory.restore.name }}
                  </Button>
                </div>
                <RouterLink
                  v-else
                  :to="{ name: 'directory', params: { projectSlug: project.slug, directorySlug: directory.slug } }"
                  class="group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent/60"
                  :class="{
                    'bg-accent/60': directory.stream?.status === 'RUNNING',
                    'border border-destructive/40': directory.stream?.status === 'ERROR',
                    'border border-valid/40': directory.stream?.status === 'STOPPED'
                  }"
                  @click.capture="runDefaultActionFromRow($event, directory)"
                >
                  <span
                    v-if="directory.stream?.unread"
                    class="pointer-events-none absolute -right-0.5 -top-0.5 z-10"
                  >
                    <span class="relative flex size-3">
                      <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
                      <span class="relative inline-flex size-3 rounded-full bg-sky-500" />
                    </span>
                  </span>
                  <Icon
                    :icon="iconFromMeta(directory.meta, 'lucide:folder-tree')"
                    class="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span class="min-w-0 flex-1 truncate">{{ directory.name }}</span>
                  <div class="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button
                      v-if="directory.defaultAction && directory.defaultAction.trigger !== 'row' && !(directory.defaultAction.command && directory.stream?.status === 'RUNNING')"
                      size="icon"
                      variant="ghost"
                      class="size-6"
                      :title="directory.defaultAction.shortcut.name"
                      @click.prevent.stop="directory.defaultAction.shortcut.open()"
                    >
                      <Icon
                        :icon="directory.defaultAction.shortcut.icon"
                        class="size-3.5"
                      />
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
                  <ShortcutLine
                    v-for="shortcut in directory.icons"
                    :key="shortcut.key"
                    :shortcut="shortcut"
                    compact
                  />
                </RouterLink>

                <div
                  v-if="directory.lines.length"
                  class="space-y-1 pl-2"
                >
                  <ShortcutLine
                    v-for="shortcut in directory.lines"
                    :key="shortcut.key"
                    :shortcut="shortcut"
                  />
                </div>

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
            </template>
          </div>
        </div>
      </div>
    </ScrollArea>
    <Separator />
    <CdnSession v-if="sidebarSettings.login" />
    <div class="flex items-center justify-between gap-2 px-3 py-2">
      <RouterLink
        :to="{ name: 'dashboard' }"
        class="min-w-0 truncate text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {{ configStore.displayName.value }} <sup>{{ appVersion }}</sup>
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
        v-if="configStore.mcp.value?.enabled"
        as-child
        size="icon"
        variant="ghost"
        class="relative size-8 shrink-0"
      >
        <RouterLink
          :to="{ name: 'agents', query: mcpWaiting ? { tab: 'waiting' } : {} }"
          :title="mcpWaiting ? `Agents: ${mcpWaiting} waiting` : 'Agents'"
        >
          <Bot
            class="size-3.5"
            :class="{ 'text-primary': route.name === 'agents' }"
            :stroke-width="route.name === 'agents' ? 2.5 : 2"
          />
          <span
            v-if="mcpWaiting"
            class="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-amber-500 text-[10px] font-semibold text-white"
          >{{ mcpWaiting }}</span>
        </RouterLink>
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
