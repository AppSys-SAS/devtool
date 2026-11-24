import { ref } from 'vue'
import type { ForgeItemsPayload, ForgeTimelinePayload } from '@appsys/devtool-shared'

/**
 * Open pull requests and issues of the integrations, as the server last read them, and the timelines
 * of the items opened.
 */
class ForgeItemsStore {
  states = ref<Record<string, ForgeItemsPayload>>({})

  timelines = ref<Record<string, ForgeTimelinePayload>>({})

  /**
   * Takes the state sent by the server.
   * @param payload The items of each integration, empty once disconnected from the server.
   */
  load (payload: ForgeItemsPayload[]): void {
    this.states.value = Object.fromEntries(payload.map(state => [state.key, state]))
    if (!payload.length) {
      this.timelines.value = {}
    }
  }

  /**
   * Takes a part of the timeline of an item sent by the server: its last events, or the events before
   * those already received.
   * @param payload The part of the timeline.
   */
  loadTimeline (payload: ForgeTimelinePayload): void {
    const id = `${payload.key}#${payload.number}`
    const known = this.timelines.value[id]
    const timeline = payload.previous && known ? { ...payload, events: [...payload.events, ...known.events] } : payload
    this.timelines.value = { ...this.timelines.value, [id]: timeline }
  }

  /**
   * Gives the items of an integration.
   * @param key The integration, `<section>[/<project>]/<slug>`.
   * @returns Its state, null before the server sends it.
   */
  get (key: string): ForgeItemsPayload | null {
    return this.states.value[key] ?? null
  }

  /**
   * Gives the timeline of an item.
   * @param key The integration.
   * @param number The number of the item.
   * @returns Its timeline, null until the server sends it.
   */
  timelineOf (key: string, number: number): ForgeTimelinePayload | null {
    return this.timelines.value[`${key}#${number}`] ?? null
  }
}

export default new ForgeItemsStore()
