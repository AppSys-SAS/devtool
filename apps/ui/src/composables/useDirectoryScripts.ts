import { computed, toValue, watch, type ComputedRef, type MaybeRefOrGetter } from "vue";
import type { DirectoryDefinition, ScriptsPayload } from "@appsys/devtool-shared";
import filesStore, { scriptsKey } from "@/stores/files";
import wsStore from "@/stores/ws";

/**
 * Lists the scripts of a directory, again whenever its folders of scripts or the connection change.
 * @param projectSlug The slug of the project.
 * @param directory The directory.
 * @returns Its scripts, null until the server lists them.
 */
export function useDirectoryScripts(
  projectSlug: MaybeRefOrGetter<string>,
  directory: MaybeRefOrGetter<DirectoryDefinition>,
): ComputedRef<ScriptsPayload | null> {
  watch(
    [() => toValue(projectSlug), () => toValue(directory).slug, () => toValue(directory).scripts, wsStore.connected],
    ([project, directorySlug, folders, connected]) => {
      if (connected && folders.length) {
        wsStore.scriptsList(project, directorySlug);
      }
    },
    { immediate: true },
  );

  return computed(() => filesStore.scripts.value[scriptsKey(toValue(projectSlug), toValue(directory).slug)] ?? null);
}
