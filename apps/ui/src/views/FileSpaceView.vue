<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, type RouteLocationNormalized, useRoute, useRouter } from "vue-router";
import { useEventListener } from "@vueuse/core";
import { AGENT_SKILL_FILE, agentSkillFolderOf, type DirectoryExtra, type FileEntryPayload } from "@appsys/devtool-shared";
import CodeEditor from "@/components/CodeEditor.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import AgentSkillEditor from "@/components/files/AgentSkillEditor.vue";
import MarkdownPreview from "@/components/files/MarkdownPreview.vue";
import FileExplorer from "@/components/files/FileExplorer.vue";
import FileHeader from "@/components/files/FileHeader.vue";
import PromptDialog from "@/components/PromptDialog.vue";
import SidebarToggle from "@/components/SidebarToggle.vue";
import { useEditedFile } from "@/composables/useEditedFile";
import { runDirectoryCommand } from "@/lib/directory-commands";
import configStore from "@/stores/config";
import filesStore from "@/stores/files";
import wsStore from "@/stores/ws";

const props = withDefaults(
  defineProps<{
    space: string;
    name: string;
    commands?: DirectoryExtra[];
    restore?: DirectoryExtra | null;
    projectSlug?: string | null;
    directorySlug?: string | null;
  }>(),
  { commands: () => [], restore: null, projectSlug: null, directorySlug: null },
);

const MARKDOWN_EXTENSION = /\.(md|markdown)$/i;

const route = useRoute();
const router = useRouter();

const tree = computed(() => filesStore.trees.value[props.space] ?? null);
const filePaths = computed(() => tree.value?.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path) ?? []);
const path = computed(() => {
  const asked = route.query.path;
  if (typeof asked === "string" && filePaths.value.includes(asked)) {
    return asked;
  }
  return tree.value && !tree.value.editable ? (filePaths.value[0] ?? null) : null;
});
const { file, draft, dirty, saving, save, revert } = useEditedFile(() => props.space, path);
const skillFolder = computed(() => (tree.value?.agentSkills && path.value ? agentSkillFolderOf(path.value) : null));
const markdown = computed(() => MARKDOWN_EXTENSION.test(path.value ?? ""));
const preview = shallowRef(false);

const leaveOpen = shallowRef(false);
let pendingLeave: string | null = null;
const pendingSelect = shallowRef<string | null>(null);

const promptOpen = shallowRef(false);
const promptTitle = shallowRef("");
const promptLabel = shallowRef("");
const promptValue = shallowRef("");
let promptAction: (value: string) => void = () => undefined;

const removeOpen = shallowRef(false);
const removeTarget = shallowRef<{ path: string; kind: FileEntryPayload["kind"] } | null>(null);

watch(
  [() => props.space, wsStore.connected, configStore.projects],
  ([space, connected]) => {
    if (connected) {
      wsStore.filesList(space);
    }
  },
  { immediate: true },
);

watch(filePaths, (paths) => {
  if (pendingSelect.value && paths.includes(pendingSelect.value)) {
    void router.push({ query: { path: pendingSelect.value } });
    pendingSelect.value = null;
  }
});

/**
 * Holds a navigation away from a changed draft until the developer agrees to discard it.
 * @param to Where the navigation goes.
 * @returns Whether the navigation goes on.
 */
function guardLeave(to: RouteLocationNormalized): boolean {
  if (!dirty.value) {
    return true;
  }

  pendingLeave = to.fullPath;
  leaveOpen.value = true;
  return false;
}

/**
 * Discards the draft and goes on with the held navigation.
 */
function discardAndLeave(): void {
  revert();
  if (pendingLeave) {
    void router.push(pendingLeave);
  }
}

/**
 * Opens the dialog asking for a path.
 * @param title The title of the dialog.
 * @param label The label of its confirmation button.
 * @param value The path proposed.
 * @param action Runs with the path confirmed.
 */
function askPath(title: string, label: string, value: string, action: (value: string) => void): void {
  promptTitle.value = title;
  promptLabel.value = label;
  promptValue.value = value;
  promptAction = action;
  promptOpen.value = true;
}

/**
 * Asks for the path of a new file or folder, then creates it and opens it when it is a file. A folder at
 * the root of a folder of agent skills is a new skill, whose `SKILL.md` is opened.
 * @param parent The folder it goes in, empty for the root.
 * @param kind Whether a file or a folder is created.
 */
function create(parent: string, kind: FileEntryPayload["kind"]): void {
  const skill = Boolean(tree.value?.agentSkills) && !parent && kind === "directory";
  askPath(skill ? "New skill" : kind === "file" ? "New file" : "New folder", "Create", parent ? `${parent}/` : "", (value) => {
    wsStore.fileCreate(props.space, value, kind);
    if (kind === "file" || skill) {
      pendingSelect.value = skill ? `${value}/${AGENT_SKILL_FILE}` : value;
    }
  });
}

/**
 * Asks for the new path of a file or folder, then renames it, following the open file.
 * @param from The current path.
 */
function rename(from: string): void {
  askPath("Rename or move", "Rename", from, (to) => {
    wsStore.fileRename(props.space, from, to);
    const current = path.value;
    if (current === from || current?.startsWith(`${from}/`)) {
      pendingSelect.value = `${to}${current.slice(from.length)}`;
    }
  });
}

/**
 * Asks for confirmation before removing a file or folder.
 * @param target The path of the file or folder.
 * @param kind Whether it is a file or a folder.
 */
function askRemove(target: string, kind: FileEntryPayload["kind"]): void {
  removeTarget.value = { path: target, kind };
  removeOpen.value = true;
}

/**
 * Removes the file or folder confirmed.
 */
function remove(): void {
  if (removeTarget.value) {
    wsStore.fileRemove(props.space, removeTarget.value.path);
  }
}

/**
 * Runs a command of the directory owning the space in the background, its output and questions shown
 * in a dialog.
 * @param command The command.
 */
function run(command: DirectoryExtra): void {
  const space = props.space;
  if (props.projectSlug && props.directorySlug) {
    runDirectoryCommand(props.projectSlug, props.directorySlug, command, { onFinished: () => wsStore.filesList(space) });
  }
}

onBeforeRouteLeave(guardLeave);
onBeforeRouteUpdate(guardLeave);
useEventListener(window, "beforeunload", (event: BeforeUnloadEvent) => {
  if (dirty.value) {
    event.preventDefault();
  }
});
</script>

<template>
  <div class="flex h-full min-h-0">
    <FileExplorer
      :name="name"
      :tree="tree"
      :current="path"
      :dirty="dirty"
      :commands="commands"
      :restore="restore"
      @refresh="wsStore.filesList(space)"
      @run="run"
      @create="create"
      @rename="rename"
      @remove="askRemove"
    />
    <div
      v-if="path && file"
      class="flex min-w-0 flex-1 flex-col"
    >
      <FileHeader
        :root="tree?.root ?? ''"
        :file="file"
        :dirty="dirty"
        :saving="saving"
        :previewable="markdown && !file.binary"
        v-model:preview="preview"
        @save="save"
        @revert="revert"
      />
      <AgentSkillEditor
        v-if="!file.binary && skillFolder"
        v-model="draft"
        class="min-h-0 flex-1"
        :path="path"
        :folder="skillFolder"
        :preview="preview"
        @save="save"
      />
      <div
        v-else-if="!file.binary"
        class="flex min-h-0 flex-1"
      >
        <div class="min-w-0 flex-1">
          <CodeEditor
            v-model="draft"
            :path="path"
            @save="save"
          />
        </div>
        <MarkdownPreview
          v-if="markdown && preview"
          :source="draft"
          class="min-w-0 flex-1 border-l"
        />
      </div>
    </div>
    <div
      v-else
      class="flex min-w-0 flex-1 items-start justify-between gap-2 p-4"
    >
      <p class="p-2 text-sm text-muted-foreground">
        {{ path ? "Loading…" : "Choose a file." }}
      </p>
      <SidebarToggle side="right" />
    </div>

    <ConfirmDialog
      v-model:open="leaveOpen"
      title="Discard unsaved changes?"
      confirm-label="Discard"
      @confirm="discardAndLeave"
    >
      <p>The changes to {{ path }} are not saved.</p>
    </ConfirmDialog>
    <ConfirmDialog
      v-model:open="removeOpen"
      :title="removeTarget?.kind === 'directory' ? 'Remove the folder?' : 'Remove the file?'"
      confirm-label="Remove"
      @confirm="remove"
    >
      <p>
        <span class="font-mono">{{ removeTarget?.path }}</span>
        <template v-if="removeTarget?.kind === 'directory'"> and everything it holds</template>
        will be deleted from the disk.
      </p>
    </ConfirmDialog>
    <PromptDialog
      v-model:open="promptOpen"
      v-model="promptValue"
      :title="promptTitle"
      :confirm-label="promptLabel"
      @confirm="promptAction(promptValue.trim())"
    >
      <p>Path relative to <span class="font-mono">{{ tree?.root }}</span>.</p>
    </PromptDialog>
  </div>
</template>
