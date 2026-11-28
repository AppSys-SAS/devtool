/**
 * Follows the lists asked to the server, such as the tables of a database or the keys differing
 * between two copies, each list named by a key and depending on a stamp that changes whenever the
 * list may change: one request per list at a time, and a list kept only when it answers the request
 * made for the current stamp.
 */
export class ChoiceRequests {
  private readonly _pending = new Map<string, string>()
  private readonly _kept = new Map<string, string>()

  /**
   * Records a request for a list, unless one is already waiting for its answer.
   * @param key The list.
   * @param stamp What the list depends on now.
   * @returns True when the request must be sent.
   */
  ask (key: string, stamp: string): boolean {
    if (this._pending.has(key)) {
      return false
    }
    this._pending.set(key, stamp)
    return true
  }

  /**
   * Tells whether a list the server sent may be kept: it answers the request made for the current
   * stamp, or it was kept already for that stamp.
   * @param key The list.
   * @param stamp What the list depends on now, null when it no longer exists.
   * @returns True when the list is kept, false when it must be forgotten.
   */
  settle (key: string, stamp: string | null): boolean {
    const asked = this._pending.get(key)
    this._pending.delete(key)
    const answers = asked ?? this._kept.get(key)
    if (stamp !== null && answers === stamp) {
      this._kept.set(key, stamp)
      return true
    }
    this._kept.delete(key)
    return false
  }

  /**
   * Tells whether a kept list was made for another stamp than the current one.
   * @param key The list.
   * @param stamp What the list depends on now.
   * @returns True when the list is kept and stale.
   */
  isStale (key: string, stamp: string): boolean {
    const kept = this._kept.get(key)
    return kept !== undefined && kept !== stamp
  }

  /**
   * Forgets a kept list, a request still waiting being settled when its answer arrives.
   * @param key The list.
   */
  forget (key: string): void {
    this._kept.delete(key)
  }

  /**
   * Forgets every list and every request, once no answer can arrive any more.
   */
  clear (): void {
    this._pending.clear()
    this._kept.clear()
  }
}
