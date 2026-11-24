import { ref, type InjectionKey } from 'vue'
import { useStorage } from '@vueuse/core'

export type SidebarSide = 'left' | 'right'

/** Provided as true by a view that shows a sidebar on its right. */
export const rightSidebarKey: InjectionKey<boolean> = Symbol('rightSidebar')

class LayoutStore {
  /** The sidebars the user hid, remembered across reloads. */
  hidden = useStorage<Record<SidebarSide, boolean>>('devtool-hidden-sidebars', { left: false, right: false }, localStorage, { mergeDefaults: true })

  /** How many displayed views let the sidebars be hidden. */
  collapsibleViews = ref(0)

  /**
   * Tells whether a sidebar shows: always, unless hidden while a view lets it be.
   * @param side The side of the sidebar.
   * @returns Whether it shows.
   */
  isVisible (side: SidebarSide): boolean {
    return !this.hidden.value[side] || this.collapsibleViews.value === 0
  }

  /**
   * Hides a sidebar when it shows, shows it otherwise.
   * @param side The side of the sidebar.
   */
  toggle (side: SidebarSide): void {
    this.hidden.value = { ...this.hidden.value, [side]: !this.hidden.value[side] }
  }
}

export default new LayoutStore()
