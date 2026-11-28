import { describe, expect, it } from 'vitest'
import { remoteChangedSince } from '@/lib/sync-changes'

const SYNCED_AT = '2026-01-01T00:00:00.000Z'

describe('remoteChangedSince', () => {
  it('tells a new version of the same date from the synchronized one', () => {
    expect(remoteChangedSince({ size: 3, updatedAt: SYNCED_AT, version: 'v2' }, { localUpdatedAt: SYNCED_AT, remoteUpdatedAt: SYNCED_AT, remoteVersion: 'v1' })).toBe(true)
  })

  it('keeps an unchanged version unchanged, whatever its date', () => {
    expect(remoteChangedSince({ size: 3, updatedAt: '2026-01-02T00:00:00.000Z', version: 'v1' }, { localUpdatedAt: SYNCED_AT, remoteUpdatedAt: SYNCED_AT, remoteVersion: 'v1' })).toBe(false)
  })

  it('compares the dates when a version is missing', () => {
    expect(remoteChangedSince({ size: 3, updatedAt: '2026-01-01T00:00:00.500Z', version: 'v2' }, { localUpdatedAt: SYNCED_AT, remoteUpdatedAt: SYNCED_AT, remoteVersion: null })).toBe(false)
    expect(remoteChangedSince({ size: 3, updatedAt: '2026-01-01T00:00:05.000Z', version: null }, { localUpdatedAt: SYNCED_AT, remoteUpdatedAt: SYNCED_AT, remoteVersion: 'v1' })).toBe(true)
  })
})
