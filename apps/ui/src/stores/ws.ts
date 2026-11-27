import { ref } from 'vue'
import type { EnvironmentAction, EnvironmentKeyChoicePayload, FileEntryPayload, PortConflictAction, SidebarOrderChange } from '@appsys-sas/devtool-shared'
import configStore from './config'
import filesStore from './files'
import certificatesStore from './certificates'
import forgeItemsStore from './forge-items'
import environmentStore from './environment'
import mcpStore from './mcp'
import secretsStore from './secrets'
import sessionStore from './session'

class WsStore {
  connected = ref(false)

  loading = ref(false)

  error = ref<string | null>(null)

  private socket: WebSocket | null = null

  /**
   * Opens the connection to the server, leaving the handshake timeout to the browser.
   */
  connect (): void {
    if (this.socket) {
      return
    }

    this.loading.value = true
    this.error.value = null
    this.connected.value = false
    configStore.loadConfig(null)

    const protocol = `ws${window.location.protocol === 'https:' ? 's' : ''}`
    this.socket = new WebSocket(`${protocol}://${window.location.host}/ws/`)

    this.socket.onmessage = event => {
      try {
        const payload = JSON.parse(event.data as string) as { type: string, data: unknown }
        switch (payload.type) {
          case 'config':
            if (this.loading.value || !this.connected.value) {
              this.loading.value = false
              this.connected.value = true
            }
            configStore.loadConfig(payload.data as never)
            break
          case 'fileTree':
            filesStore.loadTree(payload.data as never)
            break
          case 'file':
            filesStore.loadFile(payload.data as never)
            break
          case 'authSession':
            sessionStore.load(payload.data as never)
            break
          case 'environment':
            environmentStore.load(payload.data as never)
            break
          case 'secretRequest':
            secretsStore.add(payload.data as never)
            break
          case 'secretDone':
            secretsStore.remove((payload.data as { id: string }).id)
            break
          case 'certificates':
            certificatesStore.load(payload.data as never)
            break
          case 'forgeItems':
            forgeItemsStore.load(payload.data as never)
            break
          case 'forgeTimeline':
            forgeItemsStore.loadTimeline(payload.data as never)
            break
          case 'environmentKeys':
            environmentStore.loadKeys(payload.data as never)
            break
          case 'environmentTables':
            environmentStore.loadTables(payload.data as never)
            break
          case 'streamUpdate':
            configStore.streamUpdate(payload.data as never)
            break
          case 'streamRedirect':
            configStore.streamRedirect(payload.data as never)
            break
          case 'streamOutput':
            configStore.streamOutput(payload.data as never)
            break
          case 'streamRemove':
            configStore.streamRemove(payload.data as never)
            break
          case 'mcpState':
            mcpStore.load(payload.data as never)
            break
          case 'mcpHistory':
            mcpStore.loadHistory(payload.data as never)
            break
          case 'mcpMessage':
            mcpStore.addMessage(payload.data as never)
            break
          default:
            break
        }
      } catch {
        // No-op.
      }
    }

    this.socket.onclose = () => {
      if (!this.error.value) {
        this.error.value = 'The connection has been lost.'
      }
      this.disconnect(true)
    }

    this.socket.onerror = () => {
      if (!this.error.value) {
        this.error.value = 'A connection error has occurred.'
      }
      this.disconnect()
    }
  }

  send (type: string, data: unknown): void {
    this.socket?.send(JSON.stringify({ type, data }))
  }

  newCommandStream (
    projectSlug: string | null,
    directorySlug: string | null,
    primary: boolean,
    args: string[],
    env: Record<string, string>,
    killSignal: string | null,
    notifications: boolean,
    name: string | null = null,
    options: Record<string, unknown> = {}
  ): void {
    this.send('newCommandStream', {
      projectSlug,
      directorySlug,
      primary,
      args,
      env,
      killSignal,
      notifications,
      name: name ?? args.join(' '),
      options
    })
  }

  newCommandDetached (projectSlug: string, directorySlug: string, args: string[], env: Record<string, string>, options: Record<string, unknown> = {}): void {
    this.send('newCommandDetached', {
      projectSlug,
      directorySlug,
      args,
      env,
      options
    })
  }

  updateCommandStream (streamSlug: string, action: 'start' | 'stop' | 'restart' | 'close', options: Record<string, unknown> = {}): void {
    this.send('updateCommandStream', { streamSlug, action, options })
  }

  /**
   * Asks to free the port a command could not use, or to forget the conflict.
   * @param streamSlug The stream of the command.
   * @param action Stop the holders, also running the command again, or leave them.
   */
  resolvePortConflict (streamSlug: string, action: PortConflictAction): void {
    this.send('portConflict', { streamSlug, action })
  }

  streamInput (streamSlug: string, data: string): void {
    this.send('streamInput', { streamSlug, data })
  }

  streamResize (streamSlug: string, cols: number, rows: number): void {
    this.send('streamResize', { streamSlug, cols, rows })
  }

  reconfigure (): void {
    this.send('reconfigure', {})
  }

  /**
   * Asks the server to sign the developer in.
   */
  authLogin (): void {
    this.send('authLogin', {})
  }

  /**
   * Asks the server to sign the developer out.
   */
  authLogout (): void {
    this.send('authLogout', {})
  }

  /**
   * Asks the server to download the shared devtool configuration and load it.
   */
  envPullConfig (): void {
    this.send('envPullConfig', {})
  }

  /**
   * Asks the server to renew a certificate now.
   * @param name The name of the certificate in the configuration.
   * @param tag Identifies the renewal command for this interface.
   */
  certificateRenew (name: string, tag: string): void {
    this.send('certificateRenew', { name, tag })
  }

  /**
   * Asks the server to read the pull requests or issues of an integration now.
   * @param key The integration, `<section>[/<project>]/<slug>`.
   */
  forgeItemsRefresh (key: string): void {
    this.send('forgeItemsRefresh', { key })
  }

  /**
   * Asks the server for a part of the timeline of a pull request or an issue.
   * @param key The integration, `<section>[/<project>]/<slug>`.
   * @param number The number of the item.
   * @param before Where the events asked for start, as the previous part gave it, null for the last events.
   */
  forgeTimelineRead (key: string, number: number, before: string | null = null): void {
    this.send('forgeTimelineRead', { key, number, before })
  }

  /**
   * Asks the server to start an agent run by a command, in a terminal of a project or of one of its
   * directories, shown once started.
   * @param agent The slug of the agent.
   * @param projectSlug The project the agent works in.
   * @param directorySlug The directory the agent works in, null for the project itself.
   * @param prompt The prompt given to the agent.
   * @param name The name of the terminal.
   */
  agentStart (agent: string, projectSlug: string, directorySlug: string | null, prompt: string, name: string): void {
    this.send('agentStart', { agent, projectSlug, directorySlug, prompt, name })
  }

  /**
   * Asks the server to write how lists of the sidebar are ordered, then to reload the configuration.
   * @param changes The lists, their modes and orders, and the files written.
   */
  sidebarSetOrder (changes: SidebarOrderChange[]): void {
    this.send('sidebarSetOrder', { changes })
  }

  /**
   * Asks the server to describe the development environment again.
   */
  envRefresh (): void {
    this.send('envRefresh', {})
  }

  /**
   * Asks the server for the tables of the local database of an environment item.
   * @param path The path of the item.
   */
  envTables (path: string): void {
    this.send('envTables', { path })
  }

  /**
   * Asks the server for the keys differing between the local and backend copies of a YAML item.
   * @param path The path of the item.
   */
  envKeys (path: string): void {
    this.send('envKeys', { path })
  }

  /**
   * Asks the server to run an action over environment items.
   * @param action Pull or push the items, restore their local data from their local copies, or remove those copies.
   * @param targets The items, with the tables of the databases and the keys of the YAML files (null for the whole item).
   */
  envRun (action: EnvironmentAction, targets: { path: string, tables: string[] | null, keys: EnvironmentKeyChoicePayload[] | null }[]): void {
    this.send('envRun', { action, targets })
  }

  /**
   * Asks the server to cancel downloads of the pull in progress.
   * @param index The step of the item, null for every step not finished.
   */
  envCancel (index: number | null): void {
    this.send('envCancel', { index })
  }

  /**
   * Asks the server to forget the last finished pull or push.
   */
  envDismissRun (): void {
    this.send('envDismissRun', {})
  }

  /**
   * Asks the server for the files of a file space.
   * @param space The identifier of the space.
   */
  filesList (space: string): void {
    this.send('filesList', { space })
  }

  /**
   * Asks the server for a file of a file space.
   * @param space The identifier of the space.
   * @param path The path of the file.
   */
  fileRead (space: string, path: string): void {
    this.send('fileRead', { space, path })
  }

  /**
   * Asks the server to replace a file of a file space.
   * @param space The identifier of the space.
   * @param path The path of the file.
   * @param content The new content.
   * @param baseUpdatedAt Last change of the file the content was edited from, null when it did not exist.
   */
  fileWrite (space: string, path: string, content: string, baseUpdatedAt: string | null): void {
    this.send('fileWrite', { space, path, content, baseUpdatedAt })
  }

  /**
   * Asks the server to create an empty file, or a folder, in a file space.
   * @param space The identifier of the space.
   * @param path The path of the file or folder.
   * @param kind Whether a file or a folder is created.
   */
  fileCreate (space: string, path: string, kind: FileEntryPayload['kind']): void {
    this.send('fileCreate', { space, path, kind })
  }

  /**
   * Asks the server to remove a file, or a folder with everything it holds, from a file space.
   * @param space The identifier of the space.
   * @param path The path of the file or folder.
   */
  fileRemove (space: string, path: string): void {
    this.send('fileRemove', { space, path })
  }

  /**
   * Asks the server to rename or move a file or folder inside a file space.
   * @param space The identifier of the space.
   * @param from Its current path.
   * @param to Its new path.
   */
  fileRename (space: string, from: string, to: string): void {
    this.send('fileRename', { space, from, to })
  }

  disconnect (alreadyClosed = false): void {
    if (!alreadyClosed && this.socket) {
      this.socket.close()
    }
    this.loading.value = false
    this.connected.value = false
    this.socket = null
    configStore.reset()
    sessionStore.load(null)
    environmentStore.load(null)
    secretsStore.reset()
    certificatesStore.load([])
    forgeItemsStore.load([])
  }
}

export default new WsStore()
