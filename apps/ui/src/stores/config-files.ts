import { ref } from "vue";
import type { ConfigFilePayload, ConfigFilesPayload } from "@appsys/devtool-shared";

/**
 * Editable configuration files of the development environment and the last state the server sent
 * of each of them.
 */
class ConfigFilesStore {
  paths = ref<string[]>([]);

  files = ref<Record<string, ConfigFilePayload>>({});

  /**
   * Takes the editable files sent by the server.
   * @param payload The files, or null once disconnected from the server.
   */
  loadPaths(payload: ConfigFilesPayload | null): void {
    this.paths.value = payload?.paths ?? [];
  }

  /**
   * Keeps the state of a file sent by the server.
   * @param payload The file.
   */
  loadFile(payload: ConfigFilePayload): void {
    this.files.value = { ...this.files.value, [payload.path]: payload };
  }
}

export default new ConfigFilesStore();
