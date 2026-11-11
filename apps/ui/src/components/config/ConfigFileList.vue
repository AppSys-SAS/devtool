<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { FileCog, FileUser, FolderTree } from "@lucide/vue";
import { cn } from "@/lib/utils";

const props = defineProps<{
  paths: string[];
  current: string | null;
  dirty: boolean;
}>();

const groups = computed(() => {
  const byProject = new Map<string, { path: string; name: string; local: boolean }[]>();
  for (const path of props.paths) {
    const separator = path.indexOf("/");
    const project = path.slice(0, separator);
    const name = path.slice(separator + 1);
    byProject.set(project, [...(byProject.get(project) ?? []), { path, name, local: /\.local\.ya?ml$/.test(name) }]);
  }

  return [...byProject.entries()].map(([project, files]) => ({ project, files }));
});
</script>

<template>
  <nav class="flex flex-col gap-4 px-3 py-3">
    <div
      v-for="group in groups"
      :key="group.project"
      class="space-y-1"
    >
      <div class="flex items-center gap-2 px-2 py-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <FolderTree class="size-3.5" />
        {{ group.project }}
      </div>
      <RouterLink
        v-for="file in group.files"
        :key="file.path"
        :to="{ name: 'configs', query: { path: file.path } }"
        :class="cn(
          'ml-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
          file.path === current ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        )"
      >
        <FileUser
          v-if="file.local"
          class="size-4 shrink-0"
        />
        <FileCog
          v-else
          class="size-4 shrink-0"
        />
        <span class="truncate">{{ file.name }}</span>
        <span
          v-if="dirty && file.path === current"
          class="ml-auto size-2 shrink-0 rounded-full bg-amber-500"
        />
      </RouterLink>
    </div>
  </nav>
</template>
