<script setup lang="ts">
import { computed, provide } from 'vue'
import { Icon } from '@iconify/vue'
import { Bookmark, FolderTree, Sparkles } from '@lucide/vue'
import { RouterLink, RouterView } from 'vue-router'
import type { DirectoryExtra } from '@appsys/devtool-shared'
import CommandItem from '@/components/CommandItem.vue'
import IntegrationLink from '@/components/IntegrationLink.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import bookmarkStore from '@/stores/bookmark'
import configStore from '@/stores/config'
import layoutStore, { rightSidebarKey } from '@/stores/layout'

const props = defineProps<{
  projectSlug: string
  directorySlug: string
}>()

provide(rightSidebarKey, true)

type DirectoryCommand
  = | {
    type: 'external-link'
    name: string
    icon: string
    href: string
  }
  | {
    type: 'command'
    name: string
    command: DirectoryExtra
  }

const directoryDefinition = computed(() => configStore.getDirectory(props.projectSlug, props.directorySlug))
const directory = computed(() => directoryDefinition.value?.directory ?? null)
const projectName = computed(() => directoryDefinition.value?.project.name ?? props.projectSlug)
const directoryName = computed(() => directoryDefinition.value?.directory.name ?? props.directorySlug)
const directoryDescription = computed(() => directoryDefinition.value?.directory.description ?? null)
const scripts = computed(() => Object.values(directory.value?.extras ?? {}).filter(extra => extra.script))

const commands = computed<DirectoryCommand[]>(() => {
  const directory = directoryDefinition.value?.directory
  if (!directory) {
    return []
  }

  const nextCommands: DirectoryCommand[] = []

  const hosts = new Set<string>()
  for (const service of Object.values(directory.loadBalancer)) {
    for (const host of service.hosts) {
      hosts.add(host)
    }
  }
  for (const host of hosts) {
    nextCommands.push({
      type: 'external-link',
      name: host,
      icon: 'lucide:globe',
      href: `https://${host}`
    })
  }

  for (const command of Object.values(directory.extras).filter(extra => !extra.script)) {
    nextCommands.push({ type: 'command', name: command.slug, command })
  }

  return nextCommands
})

const bookmarkSlug = computed(() => `${props.projectSlug}/${props.directorySlug}`)
const isBookmarked = computed(() => bookmarkStore.slugs.value.includes(bookmarkSlug.value))

function toggleBookmark (): void {
  bookmarkStore.toggleBookmark(bookmarkSlug.value)
}

const handleOpenLinkInNewTab = (href: string) => {
  // window object is visible here
  window.open(href, '_blank')
}

</script>

<template>
  <div class="flex h-full min-h-0">
    <RouterView class="min-w-0 flex-1" />
    <aside
      v-show="layoutStore.isVisible('right')"
      class="flex w-80 shrink-0 flex-col border-l bg-card"
    >
      <ScrollArea class="min-h-0 flex-1 p-3">
        <Card>
          <CardHeader class="pb-3">
            <div class="mb-2 flex items-center justify-between gap-2">
              <Badge variant="outline">
                {{ projectName }}
              </Badge>
              <Button
                size="icon"
                variant="ghost"
                class="size-8"
                @click="toggleBookmark"
              >
                <Bookmark
                  class="size-4"
                  :class="{ 'fill-current': isBookmarked }"
                />
              </Button>
            </div>
            <CardTitle>{{ directoryName }}</CardTitle>
            <CardDescription v-if="directoryDescription">
              {{ directoryDescription }}
            </CardDescription>
          </CardHeader>
          <CardContent class="space-y-2">
            <template
              v-for="command in commands"
              :key="`${command.type}/${command.name}`"
            >
              <button
                v-if="command.type === 'external-link'"
                type="button"
                target="_blank"
                class="flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent/60"
                @click="handleOpenLinkInNewTab(command.href)"
              >
                <Icon
                  :icon="command.icon"
                  class="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <span class="min-w-0 flex-1">
                  <strong class="block truncate">{{ command.name }}</strong>
                  <span class="block truncate text-xs text-muted-foreground">{{ command.href }}</span>
                </span>
              </button>
              <CommandItem
                v-else
                :project-slug="projectSlug"
                :directory-slug="directorySlug"
                :command="command.command"
              />
            </template>
          </CardContent>
        </Card>

        <Card
          v-if="directory && Object.keys(directory.files).length"
          class="mt-3"
        >
          <CardHeader class="pb-3">
            <CardTitle class="text-sm">
              Files
            </CardTitle>
          </CardHeader>
          <CardContent class="space-y-2">
            <RouterLink
              v-for="files in directory.files"
              :key="files.slug"
              :to="{ name: 'directory-files', params: { projectSlug, directorySlug, fileSpace: files.slug } }"
              class="flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent/60"
            >
              <component
                :is="files.type === 'agentSkills' ? Sparkles : FolderTree"
                class="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              <span class="min-w-0 flex-1">
                <strong class="block truncate">{{ files.name }}</strong>
                <span class="block truncate text-xs text-muted-foreground">{{ files.path }}</span>
              </span>
            </RouterLink>
          </CardContent>
        </Card>

        <Card
          v-if="directory?.integrations.length"
          class="mt-3"
        >
          <CardHeader class="pb-3">
            <CardTitle class="text-sm">
              Integrations
            </CardTitle>
          </CardHeader>
          <CardContent class="space-y-2">
            <IntegrationLink
              v-for="integration in directory.integrations"
              :key="integration.slug"
              :integration="integration"
              :project-slug="projectSlug"
              :directory-slug="directorySlug"
            />
          </CardContent>
        </Card>

        <Card
          v-if="scripts.length"
          class="mt-3"
        >
          <CardHeader class="pb-3">
            <CardTitle class="text-sm">
              Scripts
            </CardTitle>
          </CardHeader>
          <CardContent class="space-y-1">
            <CommandItem
              v-for="script in scripts"
              :key="script.slug"
              :project-slug="projectSlug"
              :directory-slug="directorySlug"
              :command="script"
            />
          </CardContent>
        </Card>
      </ScrollArea>
    </aside>
  </div>
</template>
