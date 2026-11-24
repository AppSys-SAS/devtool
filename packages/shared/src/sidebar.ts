import type { DirectoryShortcut, SortMode } from './types.js'

/** The ways a list of the sidebar can be ordered. */
export const SORT_MODES: readonly SortMode[] = ['config', 'name', 'manual']

/**
 * Names a shortcut among the rows and directories of a project, as in its `order`.
 * @param shortcut The shortcut.
 * @returns `<type>:<slug>`, with the index of a host of a service when it is not the first.
 */
export function shortcutKey (shortcut: DirectoryShortcut): string {
  return shortcut.type === 'service' && shortcut.index ? `${shortcut.type}:${shortcut.slug}:${shortcut.index}` : `${shortcut.type}:${shortcut.slug}`
}

/**
 * Orders items of the sidebar.
 * @param items The items, in the order of the configuration, each with its key and the name shown.
 * @param sort How they are ordered.
 * @param order The keys in the order chosen by hand, read in `manual` only.
 * @returns The keys of the items in order: by name, or those of `order` first then the others in the order of the configuration.
 */
export function sortKeys (items: { key: string, name: string }[], sort: SortMode, order: string[]): string[] {
  if (sort === 'name') {
    return [...items].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true })).map(item => item.key)
  }
  const keys = items.map(item => item.key)
  if (sort === 'config') {
    return keys
  }
  const chosen = order.filter(key => keys.includes(key))
  return [...chosen, ...keys.filter(key => !chosen.includes(key))]
}
