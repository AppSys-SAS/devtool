import { computed, shallowRef } from 'vue'
import type { CommandInputValue, McpAnswer, McpHistoryEntry, McpMessagePayload, McpRequestPayload, McpStatePayload } from '@appsys/devtool-shared'
import { agentIcon, type McpLevelChange } from '@/lib/mcp'
import configStore from './config'
import notificationStore from './notification'
import wsStore from './ws'

const MCP_ROUTE = { name: 'agents' }
const WAITING_ROUTE = { name: 'agents', query: { tab: 'waiting' } }

/**
 * The agents using the MCP server: their sessions, the requests waiting for an answer, the grants,
 * the history of their calls and their messages.
 */
class McpStore {
  state = shallowRef<McpStatePayload | null>(null)

  history = shallowRef<McpHistoryEntry[]>([])

  messages = shallowRef<McpMessagePayload[]>([])

  /** The request the dialog asks, the oldest one waiting. */
  current = computed<McpRequestPayload | null>(() => this.state.value?.pending[0] ?? null)

  private readonly _notified = new Map<string, Notification | null>()

  /**
   * Gives the name of an agent as shown: the display name it gave, else its name.
   * @param client The name of the agent.
   * @returns The name shown.
   */
  clientName (client: string): string {
    return this.state.value?.titles[client] ?? client
  }

  /**
   * Gives the icon of an agent, recognized from its name and display name.
   * @param client The name of the agent.
   * @returns The icon.
   */
  clientIcon (client: string): string {
    return agentIcon(client, this.clientName(client))
  }

  /**
   * Takes the state sent by the server: notifies the requests not seen yet that ask for it and closes
   * the notifications of the requests no longer waiting.
   * @param state The state.
   */
  load (state: McpStatePayload): void {
    this.state.value = state
    const waiting = new Set(state.pending.map(request => request.id))
    for (const [id, notification] of this._notified) {
      if (!waiting.has(id)) {
        notification?.close()
        this._notified.delete(id)
      }
    }
    for (const request of state.pending) {
      if (request.notify && !this._notified.has(request.id)) {
        notificationStore.askPermission()
        this._notified.set(request.id, notificationStore.send(this.notificationTitle(request.client), request.title, WAITING_ROUTE, { force: true, persistent: true }))
      }
    }
  }

  /**
   * Gives the title of a notification about an agent.
   * @param client The name of the agent.
   * @returns The name of the devtool and of the agent.
   */
  private notificationTitle (client: string): string {
    return `${configStore.displayName.value} · ${this.clientName(client)}`
  }

  /**
   * Takes calls sent by the server: the whole history, or the calls that follow it.
   * @param payload The calls and whether they replace the history.
   * @param payload.entries The calls.
   * @param payload.initial Whether they replace the history.
   */
  loadHistory ({ entries, initial }: { entries: McpHistoryEntry[], initial: boolean }): void {
    this.history.value = initial ? entries : [...this.history.value, ...entries]
  }

  /**
   * Shows a message of an agent, notified when the notifications of agents are on.
   * @param message The message.
   */
  addMessage (message: McpMessagePayload): void {
    this.messages.value = [...this.messages.value, message]
    if (configStore.mcp.value?.notifications) {
      notificationStore.askPermission()
      notificationStore.send(this.notificationTitle(message.client), message.message, MCP_ROUTE, { force: true })
    }
  }

  /**
   * Hides a message of an agent.
   * @param id The message.
   */
  dismissMessage (id: string): void {
    this.messages.value = this.messages.value.filter(message => message.id !== id)
  }

  /**
   * Answers a waiting request.
   * @param id The request.
   * @param answer The answer.
   * @param inputs The values of the inputs of its command, as changed.
   */
  answer (id: string, answer: McpAnswer, inputs: CommandInputValue[] | null = null): void {
    wsStore.send('mcpAnswer', { id, answer, inputs })
  }

  /**
   * Removes a grant, or every grant of a scope.
   * @param key The grant, null for all of them.
   * @param scope Whether it lasts for a session or always.
   * @param session The session of a session grant, null for every session.
   */
  revoke (key: string | null, scope: 'session' | 'always', session: string | null = null): void {
    wsStore.send('mcpRevoke', { key, scope, session })
  }

  /**
   * Grants again what a call of the history asked.
   * @param historyId The call.
   * @param scope How long the grant lasts.
   */
  grant (historyId: string, scope: 'session' | 'always'): void {
    wsStore.send('mcpGrant', { historyId, scope })
  }

  /**
   * Accepts an agent always by its name, or forgets it.
   * @param name The name of the agent.
   * @param decision Whether it is accepted always or forgotten.
   */
  setClient (name: string, decision: 'always' | 'forget'): void {
    wsStore.send('mcpClient', { name, decision })
  }

  /**
   * Closes a session of an agent.
   * @param session The session.
   */
  disconnect (session: string): void {
    wsStore.send('mcpDisconnect', { session })
  }

  /**
   * Empties the history.
   */
  clearHistory (): void {
    wsStore.send('mcpClearHistory', {})
  }

  /**
   * Changes levels of MCP settings of the configuration, the server writing them in order and reloading
   * it once.
   * @param changes The settings, actions, new levels and files written.
   */
  setLevels (changes: McpLevelChange[]): void {
    wsStore.send('mcpSetLevels', { changes })
  }
}

export default new McpStore()
