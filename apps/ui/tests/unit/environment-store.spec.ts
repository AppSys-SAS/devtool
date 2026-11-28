import type { EnvironmentPayload } from '@appsys-sas/devtool-shared'
import { describe, expect, it } from 'vitest'
import environmentStore from '@/stores/environment'

/**
 * Builds a state of the environment, describing its items or not.
 * @param refreshing Whether the server describes the items.
 * @returns The state.
 */
function stateOf (refreshing: boolean): EnvironmentPayload {
  return { configured: true, backends: [], items: [], error: null, refreshing, run: null }
}

describe('environment store', () => {
  it('counts the descriptions of the items the server finished, and forgets every list once disconnected', () => {
    const before = environmentStore.descriptions
    environmentStore.load(stateOf(false))
    environmentStore.load(stateOf(true))
    environmentStore.load(stateOf(true))
    environmentStore.load(stateOf(false))
    environmentStore.load(stateOf(false))
    expect(environmentStore.descriptions).toBe(before + 1)

    environmentStore.choices.ask('tables:db.gz', '1')
    environmentStore.loadTables({ path: 'db.gz', tables: ['a'], error: null })
    environmentStore.load(null)
    expect(environmentStore.tables.value).toEqual({})
    expect(environmentStore.choices.ask('tables:db.gz', '1')).toBe(true)
  })
})
