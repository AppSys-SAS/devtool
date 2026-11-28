import { ref, watch } from 'vue'
import { useMediaQuery, useStorage } from '@vueuse/core'

export type SidebarSide = 'left' | 'right'

/** The windows too narrow to keep a sidebar beside the page: their sidebars open over it. */
const NARROW_WINDOW = '(max-width: 1023.98px)'

class LayoutStore {
  /** The sidebars the user hid, remembered across reloads. */
  hidden = useStorage<Record<SidebarSide, boolean>>('devtool-hidden-sidebars', { left: false, right: false }, localStorage, { mergeDefaults: true })

  /** How many displayed views let the sidebars be hidden. */
  collapsibleViews = ref(0)

  /** How many sidebars are displayed on each side. */
  frames = ref<Record<SidebarSide, number>>({ left: 0, right: 0 })

  /** Whether the window is too narrow to keep a sidebar beside the page. */
  narrow = useMediaQuery(NARROW_WINDOW)

  /** The sidebar opened over the page in a narrow window, null when none is. */
  opened = ref<SidebarSide | null>(null)

  /**
   * Closes the sidebar opened over the page whenever the window becomes wide or narrow.
   */
  constructor () {
    watch(this.narrow, () => {
      this.close()
    })
  }

  /**
   * Tells whether a sidebar shows: in a narrow window only while opened over the page, otherwise
   * always, unless hidden while a view lets it be.
   * @param side The side of the sidebar.
   * @returns Whether it shows.
   */
  isVisible (side: SidebarSide): boolean {
    if (this.narrow.value) {
      return this.opened.value === side
    }
    return !this.hidden.value[side] || this.collapsibleViews.value === 0
  }

  /**
   * Tells whether a sidebar is opened over the page, which the page behind it then gives up the focus to.
   * @param side The side of the sidebar.
   * @returns Whether it covers the page.
   */
  covers (side: SidebarSide): boolean {
    return this.narrow.value && this.opened.value === side
  }

  /**
   * Hides a sidebar when it shows, shows it otherwise; in a narrow window, opens it over the page
   * in place of the other one.
   * @param side The side of the sidebar.
   */
  toggle (side: SidebarSide): void {
    if (this.narrow.value) {
      this.opened.value = this.opened.value === side ? null : side
      return
    }
    this.hidden.value = { ...this.hidden.value, [side]: !this.hidden.value[side] }
  }

  /**
   * Closes the sidebar opened over the page in a narrow window.
   */
  close (): void {
    this.opened.value = null
  }
}

export default new LayoutStore()
