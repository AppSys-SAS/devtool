import { computed, type MaybeRefOrGetter, shallowRef, toValue, watch } from 'vue'
import filesStore, { fileKey } from '@/stores/files'
import wsStore from '@/stores/ws'

/**
 * Edits a file of a file space through a draft kept apart from the copy the server last sent. A new
 * copy replaces the draft unless the draft was changed from the previous one.
 * @param space The identifier of the file space.
 * @param path The path of the file, null while none is chosen.
 * @returns The file as the server sent it, the draft, whether the draft differs from the file, whether
 * a save is in progress, and the actions saving the draft or reverting it to the file on disk.
 */
export function useEditedFile (space: MaybeRefOrGetter<string>, path: MaybeRefOrGetter<string | null>) {
  const draft = shallowRef('')
  const saving = shallowRef(false)
  const file = computed(() => {
    const current = toValue(path)
    return current ? (filesStore.files.value[fileKey(toValue(space), current)] ?? null) : null
  })
  const dirty = computed(() => file.value !== null && !file.value.binary && draft.value !== (file.value.content ?? ''))

  watch(
    [() => toValue(space), () => toValue(path), wsStore.connected],
    ([currentSpace, current, connected]) => {
      if (current && connected) {
        wsStore.fileRead(currentSpace, current)
      }
    },
    { immediate: true }
  )

  watch(
    file,
    (next, previous) => {
      saving.value = false
      if (!next || next.saved || previous?.space !== next.space || previous.path !== next.path || draft.value === (previous.content ?? '')) {
        draft.value = next?.content ?? ''
      }
    },
    { immediate: true }
  )

  /**
   * Asks the server to replace the file by the draft.
   */
  function save (): void {
    const current = toValue(path)
    if (!current || !dirty.value || saving.value) {
      return
    }

    saving.value = true
    wsStore.fileWrite(toValue(space), current, draft.value, file.value?.updatedAt ?? null)
  }

  /**
   * Drops the draft and reads the file again.
   */
  function revert (): void {
    const current = toValue(path)
    draft.value = file.value?.content ?? ''
    if (current) {
      wsStore.fileRead(toValue(space), current)
    }
  }

  return { file, draft, dirty, saving, save, revert }
}
