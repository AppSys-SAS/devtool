import { computed, type MaybeRefOrGetter, shallowRef, toValue, watch } from "vue";
import configFilesStore from "@/stores/config-files";
import wsStore from "@/stores/ws";

/**
 * Edits the local copy of a configuration file through a draft kept apart from the copy the server
 * last sent. A new copy replaces the draft unless the draft was changed from the previous one.
 * @param path The path of the file, null while none is chosen.
 * @returns The file as the server sent it, the draft, whether the draft differs from the file, whether
 * a save is in progress, and the actions saving the draft or reverting it to the file on disk.
 */
export function useConfigFile(path: MaybeRefOrGetter<string | null>) {
  const draft = shallowRef("");
  const saving = shallowRef(false);
  const file = computed(() => {
    const current = toValue(path);
    return current ? (configFilesStore.files.value[current] ?? null) : null;
  });
  const dirty = computed(() => file.value !== null && draft.value !== (file.value.content ?? ""));

  watch(
    [() => toValue(path), wsStore.connected],
    ([current, connected]) => {
      if (current && connected) {
        wsStore.configRead(current);
      }
    },
    { immediate: true },
  );

  watch(
    file,
    (next, previous) => {
      saving.value = false;
      if (!next || next.saved || previous?.path !== next.path || draft.value === (previous.content ?? "")) {
        draft.value = next?.content ?? "";
      }
    },
    { immediate: true },
  );

  /**
   * Asks the server to replace the local copy by the draft.
   */
  function save(): void {
    const current = toValue(path);
    if (!current || !dirty.value || saving.value) {
      return;
    }

    saving.value = true;
    wsStore.configWrite(current, draft.value, file.value?.updatedAt ?? null);
  }

  /**
   * Drops the draft and reads the local copy again.
   */
  function revert(): void {
    const current = toValue(path);
    draft.value = file.value?.content ?? "";
    if (current) {
      wsStore.configRead(current);
    }
  }

  return { file, draft, dirty, saving, save, revert };
}
