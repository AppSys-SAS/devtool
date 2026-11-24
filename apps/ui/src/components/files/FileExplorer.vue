<script setup lang="ts">
import { computed, shallowRef } from "vue";
import { Icon } from "@iconify/vue";
import { FilePlus, FolderPlus, RefreshCw, Sparkles, TriangleAlert } from "@lucide/vue";
import type { DirectoryExtra, FileEntryPayload, FileTreePayload } from "@appsys/devtool-shared";
import FileTree from "@/components/files/FileTree.vue";
import SidebarToggle from "@/components/SidebarToggle.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

const props = defineProps<{
  name: string;
  tree: FileTreePayload | null;
  current: string | null;
  dirty: boolean;
  commands: DirectoryExtra[];
  /** The command bringing the folder back when it is missing. */
  restore: DirectoryExtra | null;
}>();

const emit = defineEmits<{
  refresh: [];
  run: [command: DirectoryExtra];
  create: [parent: string, kind: FileEntryPayload["kind"]];
  rename: [path: string];
  remove: [path: string, kind: FileEntryPayload["kind"]];
}>();

const search = shallowRef("");

const entries = computed(() => {
  const query = search.value.trim().toLowerCase();
  const skills = props.tree?.agentSkills;
  if (!skills || !query) {
    return props.tree?.entries ?? [];
  }

  const folders = new Set(skills.filter((skill) => [skill.folder, skill.name, skill.description].some((text) => text?.toLowerCase().includes(query))).map((skill) => skill.folder));
  return props.tree?.entries.filter((entry) => folders.has(entry.path.split("/")[0] ?? "")) ?? [];
});

/**
 * Gives the icon of a command from its metadata.
 * @param command The command.
 * @returns The Iconify name of its icon, a terminal by default.
 */
function commandIcon(command: DirectoryExtra): string {
  const icon = typeof command.meta === "object" && command.meta !== null ? (command.meta as { icon?: unknown }).icon : null;
  if (typeof icon !== "string" || !icon.trim()) {
    return "lucide:terminal";
  }
  return icon.includes(":") ? icon : `lucide:${icon}`;
}
</script>

<template>
  <div class="flex h-full w-64 shrink-0 flex-col border-r">
    <div class="flex items-center gap-1 border-b px-3 py-2">
      <SidebarToggle
        side="left"
        class="-ml-1.5"
      />
      <span class="min-w-0 flex-1 truncate text-xs font-semibold tracking-wide text-muted-foreground uppercase">{{ name }}</span>
      <Button
        v-if="tree?.agentSkills && tree.editable && tree.exists"
        size="icon"
        variant="ghost"
        class="size-7"
        title="New skill"
        @click="emit('create', '', 'directory')"
      >
        <Sparkles class="size-3.5" />
      </Button>
      <template v-else-if="tree?.editable && tree.exists">
        <Button
          size="icon"
          variant="ghost"
          class="size-7"
          title="New file"
          @click="emit('create', '', 'file')"
        >
          <FilePlus class="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          class="size-7"
          title="New folder"
          @click="emit('create', '', 'directory')"
        >
          <FolderPlus class="size-3.5" />
        </Button>
      </template>
      <Button
        size="icon"
        variant="ghost"
        class="size-7"
        title="Refresh"
        @click="emit('refresh')"
      >
        <RefreshCw class="size-3.5" />
      </Button>
    </div>

    <div
      v-if="commands.length"
      class="flex flex-col gap-1 border-b p-2"
    >
      <button
        v-for="command in commands"
        :key="command.slug"
        type="button"
        class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        @click="emit('run', command)"
      >
        <Icon
          :icon="commandIcon(command)"
          class="size-4 shrink-0"
        />
        <span class="truncate">{{ command.name }}</span>
      </button>
    </div>

    <div
      v-if="tree?.agentSkills?.length"
      class="border-b p-2"
    >
      <Input
        v-model="search"
        placeholder="Search skills"
        class="h-8"
      />
    </div>

    <div
      v-if="tree?.error"
      class="m-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
    >
      <TriangleAlert class="mt-0.5 size-3.5 shrink-0" />
      <span>{{ tree.error }}</span>
    </div>

    <ScrollArea class="min-h-0 flex-1">
      <p
        v-if="!tree"
        class="p-3 text-sm text-muted-foreground"
      >
        Loading…
      </p>
      <div
        v-else-if="!tree.exists"
        class="space-y-3 p-3"
      >
        <p class="text-sm break-all text-muted-foreground">
          <span class="font-mono">{{ tree.root }}</span> does not exist.
        </p>
        <Button
          v-if="restore"
          size="sm"
          class="w-full"
          @click="emit('run', restore)"
        >
          <Icon
            :icon="commandIcon(restore)"
            class="size-4"
          />
          {{ restore.name }}
        </Button>
      </div>
      <FileTree
        v-else
        class="p-2"
        :entries="entries"
        :current="current"
        :dirty="dirty"
        :editable="tree.editable"
        :agent-skills="tree.agentSkills"
        @create="(parent, kind) => emit('create', parent, kind)"
        @rename="(path) => emit('rename', path)"
        @remove="(path, kind) => emit('remove', path, kind)"
      />
    </ScrollArea>
  </div>
</template>
