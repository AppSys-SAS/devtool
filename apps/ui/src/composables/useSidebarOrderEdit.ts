import { computed, shallowRef } from 'vue'
import { shortcutKey, sortKeys, type SortMode } from '@appsys-sas/devtool-shared'
import { iconFromMeta } from '@/lib/directory-commands'
import configStore from '@/stores/config'
import wsStore from '@/stores/ws'

/** Something of the sidebar that can be ordered. */
export interface SidebarOrderItem {
  key: string
  name: string
  /** Iconify name of its icon. */
  icon: string
}

/** A list of the sidebar: the sections, or the rows and projects of one section. */
export interface SidebarOrderList {
  /** The section whose content it is, null for the sections themselves. */
  section: string | null
  /** The items in the order of the configuration. */
  items: SidebarOrderItem[]
  sort: SortMode
  /** The keys in the order chosen by hand. */
  order: string[]
}

/** How a list is ordered. */
interface Ordering {
  sort: SortMode
  order: string[]
}

/**
 * Edits how the sidebar is ordered: the changes wait, shown at once, until they are written to the
 * file chosen once for the whole edit.
 * @returns The lists, their items in the order shown, and the edit.
 */
export function useSidebarOrderEdit () {
  const file = shallowRef<'local' | 'declared' | null>(null)
  const staged = shallowRef<ReadonlyMap<string | null, Ordering>>(new Map())

  const sections = computed<SidebarOrderList>(() => ({
    section: null,
    items: Object.values(configStore.projects.value ?? {}).map(project => ({ key: project.slug, name: project.name, icon: iconFromMeta(project.meta, 'lucide:folder-tree') })),
    sort: configStore.sidebar.value.sort,
    order: configStore.sidebar.value.order
  }))

  const contents = computed<Record<string, SidebarOrderList>>(() =>
    Object.fromEntries(
      Object.values(configStore.projects.value ?? {}).map(project => [
        project.slug,
        {
          section: project.slug,
          items: [
            ...project.lines.flatMap(line => {
              const integration = project.integrations.find(item => item.slug === line.slug)
              return integration ? [{ key: shortcutKey(line), name: integration.name, icon: integration.icon }] : []
            }),
            ...Object.values(project.directories).map(directory => ({ key: directory.slug, name: directory.name, icon: iconFromMeta(directory.meta, 'lucide:folder-tree') }))
          ],
          sort: project.sort,
          order: project.order
        }
      ])
    )
  )

  /**
   * Gives how a list is ordered, its waiting change first.
   * @param list The list.
   * @returns Its mode and the keys in the order chosen by hand.
   */
  function ordering (list: SidebarOrderList): Ordering {
    return staged.value.get(list.section) ?? { sort: list.sort, order: list.order }
  }

  /**
   * Gives the items of a list in the order shown.
   * @param list The list.
   * @returns The items, in order.
   */
  function shown (list: SidebarOrderList): SidebarOrderItem[] {
    const { sort, order } = ordering(list)
    return sortKeys(list.items, sort, order).flatMap(key => list.items.find(item => item.key === key) ?? [])
  }

  /**
   * Changes how a list is ordered, a list put in order by hand keeping the order shown.
   * @param list The list.
   * @param sort The new mode.
   */
  function setSort (list: SidebarOrderList, sort: SortMode): void {
    stage(list, { sort, order: sort === 'manual' ? shown(list).map(item => item.key) : [] })
  }

  /**
   * Puts a list in an order chosen by hand.
   * @param list The list.
   * @param keys The keys of its items, in the new order.
   */
  function move (list: SidebarOrderList, keys: string[]): void {
    stage(list, { sort: 'manual', order: keys })
  }

  /**
   * Keeps the change of a list until the edit ends.
   * @param list The list.
   * @param next Its new mode and order.
   */
  function stage (list: SidebarOrderList, next: Ordering): void {
    staged.value = new Map(staged.value).set(list.section, next)
  }

  /**
   * Starts the edit, writing to the personal override when there is one.
   */
  function start (): void {
    file.value = configStore.mcp.value?.localFile ? 'local' : 'declared'
  }

  /**
   * Ends the edit, writing the changes waiting when they are kept.
   * @param keep Whether the changes are written, or dropped.
   */
  function end (keep: boolean): void {
    const target = file.value
    if (keep && target && staged.value.size) {
      wsStore.sidebarSetOrder([...staged.value].map(([section, next]) => ({ section, sort: next.sort, order: next.sort === 'manual' ? next.order : null, file: target })))
    }
    staged.value = new Map()
    file.value = null
  }

  return { file, staged, sections, contents, ordering, shown, setSort, move, start, end }
}
