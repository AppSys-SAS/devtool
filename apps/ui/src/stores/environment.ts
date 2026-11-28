import { ref } from 'vue'
import type { EnvironmentKeysPayload, EnvironmentPayload, EnvironmentTablesPayload } from '@appsys-sas/devtool-shared'
import { ChoiceRequests } from '@/lib/choice-requests'

/**
 * Development environment as the server describes it, the tables of its databases and the keys
 * differing between the copies of its configuration files.
 */
class EnvironmentStore {
  state = ref<EnvironmentPayload | null>(null)

  tables = ref<Record<string, EnvironmentTablesPayload>>({})

  keys = ref<Record<string, EnvironmentKeysPayload>>({})

  /** The lists of tables and of differing keys asked to the server, and what each one depends on. */
  readonly choices = new ChoiceRequests()

  /** Counts the descriptions of the items the server finished, which the tables of the databases depend on. */
  descriptions = 0

  /**
   * Takes the state sent by the server, counting the descriptions it finished.
   * @param payload The state, or null once disconnected from the server.
   */
  load (payload: EnvironmentPayload | null): void {
    if (this.state.value?.refreshing && payload?.refreshing === false) {
      this.descriptions += 1
    }
    this.state.value = payload
    if (!payload) {
      this.tables.value = {}
      this.keys.value = {}
      this.choices.clear()
    }
  }

  /**
   * Keeps the tables of a database sent by the server.
   * @param payload The tables of one database.
   */
  loadTables (payload: EnvironmentTablesPayload): void {
    this.tables.value = { ...this.tables.value, [payload.path]: payload }
  }

  /**
   * Keeps the differing keys of a configuration file sent by the server.
   * @param payload The differing keys of one file.
   */
  loadKeys (payload: EnvironmentKeysPayload): void {
    this.keys.value = { ...this.keys.value, [payload.path]: payload }
  }

  /**
   * Forgets the tables or the differing keys of an item, before asking for them again.
   * @param path The path of the item.
   * @param kind Whether its tables or its keys are forgotten.
   */
  forget (path: string, kind: 'tables' | 'keys'): void {
    if (kind === 'tables' && path in this.tables.value) {
      const { [path]: _tables, ...tables } = this.tables.value
      this.tables.value = tables
    }
    if (kind === 'keys' && path in this.keys.value) {
      const { [path]: _keys, ...keys } = this.keys.value
      this.keys.value = keys
    }
  }
}

export default new EnvironmentStore()
