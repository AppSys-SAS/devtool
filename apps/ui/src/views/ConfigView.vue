<script setup lang="ts">
import { computed, shallowRef } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, type RouteLocationNormalized, useRoute, useRouter } from "vue-router";
import { useEventListener } from "@vueuse/core";
import CodeEditor from "@/components/CodeEditor.vue";
import ConfigFileHeader from "@/components/config/ConfigFileHeader.vue";
import ConfigFileList from "@/components/config/ConfigFileList.vue";
import { ScrollArea } from "@/components/ui/scroll-area";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import { useConfigFile } from "@/composables/useConfigFile";
import configFilesStore from "@/stores/config-files";

const route = useRoute();
const router = useRouter();
const paths = configFilesStore.paths;

const path = computed(() => {
  const asked = route.query.path;
  return typeof asked === "string" && paths.value.includes(asked) ? asked : (paths.value[0] ?? null);
});
const { file, draft, dirty, saving, save, revert } = useConfigFile(path);

const leaveOpen = shallowRef(false);
let pendingLeave: string | null = null;

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

onBeforeRouteLeave(guardLeave);
onBeforeRouteUpdate(guardLeave);
useEventListener(window, "beforeunload", (event: BeforeUnloadEvent) => {
  if (dirty.value) {
    event.preventDefault();
  }
});
</script>

<template>
  <div class="flex h-full">
    <ScrollArea class="w-60 shrink-0 border-r">
      <ConfigFileList
        :paths="paths"
        :current="path"
        :dirty="dirty"
      />
    </ScrollArea>
    <div
      v-if="path && file"
      class="flex min-w-0 flex-1 flex-col"
    >
      <ConfigFileHeader
        :path="path"
        :file="file"
        :dirty="dirty"
        :saving="saving"
        @save="save"
        @revert="revert"
      />
      <div class="min-h-0 flex-1">
        <CodeEditor
          v-model="draft"
          :path="path"
          @save="save"
        />
      </div>
    </div>
    <p
      v-else
      class="p-6 text-sm text-muted-foreground"
    >
      Loading the configuration files…
    </p>

    <ConfirmDialog
      v-model:open="leaveOpen"
      title="Discard unsaved changes?"
      confirm-label="Discard"
      @confirm="discardAndLeave"
    >
      <p>The changes to {{ path }} are not saved.</p>
    </ConfirmDialog>
  </div>
</template>
