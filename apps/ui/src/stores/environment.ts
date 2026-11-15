import { ref } from "vue";
import type { EnvironmentKeysPayload, EnvironmentPayload, EnvironmentTablesPayload } from "@appsys/devtool-shared";

/**
 * Development environment as the server describes it, the tables of its databases and the keys
 * differing between the copies of its configuration files.
 */
class EnvironmentStore {
  state = ref<EnvironmentPayload | null>(null);

  tables = ref<Record<string, EnvironmentTablesPayload>>({});

  keys = ref<Record<string, EnvironmentKeysPayload>>({});

  /**
   * Takes the state sent by the server.
   * @param payload The state, or null once disconnected from the server.
   */
  load(payload: EnvironmentPayload | null): void {
    this.state.value = payload;
    if (!payload) {
      this.tables.value = {};
      this.keys.value = {};
    }
  }

  /**
   * Keeps the tables of a database sent by the server.
   * @param payload The tables of one database.
   */
  loadTables(payload: EnvironmentTablesPayload): void {
    this.tables.value = { ...this.tables.value, [payload.path]: payload };
  }

  /**
   * Keeps the differing keys of a configuration file sent by the server.
   * @param payload The differing keys of one file.
   */
  loadKeys(payload: EnvironmentKeysPayload): void {
    this.keys.value = { ...this.keys.value, [payload.path]: payload };
  }

  /**
   * Forgets the differing keys of a configuration file, before asking for them again.
   * @param path The path of the file.
   */
  forgetKeys(path: string): void {
    const { [path]: _forgotten, ...rest } = this.keys.value;
    this.keys.value = rest;
  }
}

export default new EnvironmentStore();
