import { ref } from "vue";
import type { FilePayload, FileTreePayload, ScriptsPayload } from "@appsys/devtool-shared";

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
 * Gives the key of the scripts of a directory.
 * @param projectSlug The project of the directory.
 * @param directorySlug The directory.
 * @returns The key.
 */
export function scriptsKey(projectSlug: string, directorySlug: string): string {
  return `${projectSlug}/${directorySlug}`;
}

/**
 * Last state the server sent of the file spaces, of their files and of the scripts of the directories.
 */
class FilesStore {
  trees = ref<Record<string, FileTreePayload>>({});

  files = ref<Record<string, FilePayload>>({});

  scripts = ref<Record<string, ScriptsPayload>>({});

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

  /**
   * Keeps the scripts of a directory sent by the server.
   * @param payload The scripts of one directory.
   */
  loadScripts(payload: ScriptsPayload): void {
    this.scripts.value = { ...this.scripts.value, [scriptsKey(payload.projectSlug, payload.directorySlug)]: payload };
  }
}

export default new FilesStore();
