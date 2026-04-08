<script setup lang="ts">
import { computed } from "vue";
import { Bookmark } from "lucide-vue-next";
import { RouterView } from "vue-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import bookmarkStore from "@/stores/bookmark";
import configStore from "@/stores/config";
import wsStore from "@/stores/ws";

const props = defineProps<{
  projectSlug: string;
  directorySlug: string;
}>();

type DirectoryCommand =
  | {
      type: "external-link";
      name: string;
      href: string;
    }
  | {
      type: "command";
      slug: string;
      name: string;
      env: Record<string, string>;
      args: string[];
      detached: boolean;
      notifications: boolean;
      description: string;
    };

const directoryDefinition = computed(() => configStore.getDirectory(props.projectSlug, props.directorySlug));
const projectName = computed(() => directoryDefinition.value?.project.name ?? props.projectSlug);
const directoryName = computed(() => directoryDefinition.value?.directory.name ?? props.directorySlug);
const directoryDescription = computed(() => directoryDefinition.value?.directory.description ?? null);

const commands = computed<DirectoryCommand[]>(() => {
  const directory = directoryDefinition.value?.directory;
  if (!directory) {
    return [];
  }

  const nextCommands: DirectoryCommand[] = [];

  const hosts = new Set<string>();
  for (const service of Object.values(directory.loadBalancer)) {
    for (const host of service.hosts) {
      hosts.add(host);
    }
  }
  for (const host of hosts) {
    nextCommands.push({
      type: "external-link",
      name: host,
      href: `https://${host}`,
    });
  }

  for (const [slug, command] of Object.entries(directory.extras)) {
    nextCommands.push({
      type: "command",
      slug,
      name: command.name || (slug === "main" ? command.args.join(" ") : slug),
      env: command.env,
      args: command.args,
      detached: command.detached,
      notifications: command.notifications,
      description: command.args.join(" "),
    });
  }

  return nextCommands;
});

const bookmarkSlug = computed(() => `${props.projectSlug}/${props.directorySlug}`);
const isBookmarked = computed(() => bookmarkStore.slugs.value.includes(bookmarkSlug.value));

function toggleBookmark(): void {
  bookmarkStore.toggleBookmark(bookmarkSlug.value);
}

function runCommand(command: Extract<DirectoryCommand, { type: "command" }>): void {
  if (command.detached) {
    wsStore.newCommandDetached(props.projectSlug, props.directorySlug, command.args, command.env);
    return;
  }

  wsStore.newCommandStream(
    props.projectSlug,
    props.directorySlug,
    false,
    command.args,
    command.env,
    command.notifications,
    command.name,
    { redirect: true },
  );
}
</script>

<template>
  <div class="flex h-full min-h-0">
    <RouterView class="min-w-0 flex-1" />
    <aside class="flex w-80 shrink-0 flex-col border-l bg-card">
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
              <a
                v-if="command.type === 'external-link'"
                :href="command.href"
                target="_blank"
                rel="noopener noreferrer"
                class="block rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent/60"
              >
                <strong class="block truncate">{{ command.name }}</strong>
                <span class="block truncate text-xs text-muted-foreground">{{ command.href }}</span>
              </a>
              <button
                v-else
                type="button"
                class="block w-full rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent/60"
                @click="runCommand(command)"
              >
                <strong class="block truncate">{{ command.name }}</strong>
                <span class="block truncate text-xs text-muted-foreground">{{ command.description }}</span>
              </button>
            </template>
          </CardContent>
        </Card>
      </ScrollArea>
    </aside>
  </div>
</template>
