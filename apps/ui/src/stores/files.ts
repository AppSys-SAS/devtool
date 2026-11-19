import { ref } from "vue";
import type { FilePayload, FileTreePayload } from "@appsys/devtool-shared";

/**
 * Gives the key of a file of a file space.
 * @param space The identifier of the space.
 * @param path The path of the file.
 * @returns The key.
 */
export function fileKey(space: string, path: string): string {
  return `${space}\n${path}`;
}

/**
 * Last state the server sent of the file spaces and of their files.
 */
class FilesStore {
  trees = ref<Record<string, FileTreePayload>>({});

  files = ref<Record<string, FilePayload>>({});

  /**
   * Keeps the files of a space sent by the server.
   * @param payload The files of one space.
   */
  loadTree(payload: FileTreePayload): void {
    this.trees.value = { ...this.trees.value, [payload.space]: payload };
  }

  /**
   * Keeps the state of a file sent by the server.
   * @param payload The file.
   */
  loadFile(payload: FilePayload): void {
    this.files.value = { ...this.files.value, [fileKey(payload.space, payload.path)]: payload };
  }
}

export default new FilesStore();
