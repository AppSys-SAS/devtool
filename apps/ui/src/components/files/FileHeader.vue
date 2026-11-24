<script setup lang="ts">
import { computed } from "vue";
import { Eye, EyeOff, Loader2, Save, TriangleAlert, Undo2 } from "@lucide/vue";
import type { FilePayload } from "@appsys/devtool-shared";
import SidebarToggle from "@/components/SidebarToggle.vue";
import { Button } from "@/components/ui/button";
import { formatRelativeDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    root: string;
    file: FilePayload;
    dirty: boolean;
    saving: boolean;
    /** Whether the file can be shown rendered next to the editor. */
    previewable?: boolean;
  }>(),
  { previewable: false },
);

const preview = defineModel<boolean>("preview", { default: false });

const emit = defineEmits<{
  save: [];
  revert: [];
}>();

const location = computed(() => `${props.root.replace(/^\/(Users|home)\/[^/]+/, "~")}/${props.file.path}`);

const status = computed(() => {
  if (props.dirty) {
    return "Unsaved changes";
  }

  if (props.file.error) {
    return "";
  }

  if (props.file.binary) {
    return "Binary file, not editable";
  }

  return props.file.updatedAt ? `Changed ${formatRelativeDate(props.file.updatedAt)}` : "Not created yet";
});
</script>

<template>
  <div class="border-b">
    <div class="flex items-center gap-3 px-4 py-2">
      <span class="min-w-0 flex-1 truncate font-mono text-sm">{{ location }}</span>
      <span
        :class="cn('shrink-0 text-xs', dirty ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')"
      >{{ status }}</span>
      <Button
        v-if="previewable"
        :variant="preview ? 'secondary' : 'outline'"
        size="sm"
        @click="preview = !preview"
      >
        <EyeOff
          v-if="preview"
          class="size-4"
        />
        <Eye
          v-else
          class="size-4"
        />
        Preview
      </Button>
      <Button
        variant="outline"
        size="sm"
        :disabled="!dirty || saving"
        @click="emit('revert')"
      >
        <Undo2 class="size-4" />
        Revert
      </Button>
      <Button
        size="sm"
        :disabled="!dirty || saving"
        @click="emit('save')"
      >
        <Loader2
          v-if="saving"
          class="size-4 animate-spin"
        />
        <Save
          v-else
          class="size-4"
        />
        Save
      </Button>
      <SidebarToggle side="right" />
    </div>
    <div
      v-if="file.error"
      class="mx-4 mb-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive"
    >
      <TriangleAlert class="mt-0.5 size-4 shrink-0" />
      <span class="whitespace-pre-wrap">
        {{ file.error }}<template v-if="file.conflict">: save again to overwrite it, or revert to load it.</template>
      </span>
    </div>
  </div>
</template>
