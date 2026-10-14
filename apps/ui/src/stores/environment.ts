import { ref } from "vue";
import type { EnvironmentPayload, EnvironmentTablesPayload } from "@appsys/devtool-shared";

/**
 * Development environment as the server describes it, and the tables of its databases.
 */
class EnvironmentStore {
  state = ref<EnvironmentPayload | null>(null);

  tables = ref<Record<string, EnvironmentTablesPayload>>({});

  /**
   * Takes the state sent by the server.
   * @param payload The state, or null once disconnected from the server.
   */
  load(payload: EnvironmentPayload | null): void {
    this.state.value = payload;
    if (!payload) {
      this.tables.value = {};
    }
  }

  /**
   * Keeps the tables of a database sent by the server.
   * @param payload The tables of one database.
   */
  loadTables(payload: EnvironmentTablesPayload): void {
    this.tables.value = { ...this.tables.value, [payload.path]: payload };
  }
}

export default new EnvironmentStore();
