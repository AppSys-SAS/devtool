import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let narrow: boolean
const changes = new Set<(event: { matches: boolean }) => void>()

/**
 * Resizes the window across the width under which the sidebars open over the page.
 * @param isNarrow Whether the window becomes narrow.
 */
async function resize (isNarrow: boolean): Promise<void> {
  narrow = isNarrow
  for (const change of changes) {
    change({ matches: isNarrow })
  }
  await nextTick()
}

/**
 * Loads the layout store in a window of a given width.
 * @param isNarrow Whether the window is narrow.
 * @returns The store.
 */
async function layoutIn (isNarrow: boolean): Promise<(typeof import('@/stores/layout'))['default']> {
  narrow = isNarrow
  return (await import('@/stores/layout')).default
}

beforeEach(() => {
  vi.resetModules()
  changes.clear()
  const stored = new Map<string, string>()
  /** A storage kept in memory. */
  class MemoryStorage {
    /**
     * Reads a value.
     * @param key The key.
     * @returns The value, null when none is stored.
     */
    getItem (key: string): string | null {
      return stored.get(key) ?? null
    }

    /**
     * Stores a value.
     * @param key The key.
     * @param value The value.
     */
    setItem (key: string, value: string): void {
      stored.set(key, value)
    }

    /**
     * Forgets a value.
     * @param key The key.
     */
    removeItem (key: string): void {
      stored.delete(key)
    }
  }
  vi.stubGlobal('document', {})
  vi.stubGlobal('Storage', MemoryStorage)
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.stubGlobal('window', {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matchMedia: () => ({
      get matches () {
        return narrow
      },
      addEventListener: (_type: string, change: (event: { matches: boolean }) => void) => changes.add(change),
      removeEventListener: (_type: string, change: (event: { matches: boolean }) => void) => changes.delete(change)
    })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('layout of the sidebars', () => {
  it('keeps both sidebars closed over a narrow page until one is opened, one at a time', async () => {
    const layout = await layoutIn(true)
    expect([layout.isVisible('left'), layout.isVisible('right')]).toEqual([false, false])

    layout.toggle('left')
    expect([layout.isVisible('left'), layout.isVisible('right')]).toEqual([true, false])
    layout.toggle('right')
    expect([layout.isVisible('left'), layout.isVisible('right')]).toEqual([false, true])
    layout.close()
    expect([layout.isVisible('left'), layout.isVisible('right')]).toEqual([false, false])
  })

  it('closes the sidebar opened over the page once the window widens, not opening it again when it narrows', async () => {
    const layout = await layoutIn(true)
    layout.toggle('left')

    await resize(false)
    expect(layout.opened.value).toBeNull()
    await resize(true)
    expect(layout.isVisible('left')).toBe(false)
  })

  it('shows the sidebars beside a wide page, hidden only where a view lets them be', async () => {
    const layout = await layoutIn(false)
    layout.toggle('left')
    expect(layout.isVisible('left')).toBe(true)

    layout.collapsibleViews.value = 1
    expect([layout.isVisible('left'), layout.isVisible('right')]).toEqual([false, true])
  })
})
