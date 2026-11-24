import { randomUUID } from 'node:crypto'
import { type FSWatcher, watch } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FilePayload, FileTreePayload, McpMessagePayload, PortOwner, RuntimeConfig, SidebarOrderChange } from '@appsys/devtool-shared'
import { logger, SORT_MODES } from '@appsys/devtool-shared'
import type { WebSocket } from 'ws'
import { DevtoolCdnSession } from './cdn-session.js'
import type { CommandAutomation } from './command-automation.js'
import { DevtoolCertificates } from './certificates.js'
import { type CommandStreamHooks, DevtoolCommandStream } from './command-stream.js'
import { acceptsMcpLevel, writeMcpLevel, writeSetting } from './config-edit.js'
import { agentAutomationKey, DevtoolConfigure } from './configure.js'
import { DevtoolEnvironment } from './environment.js'
import { DevtoolFileSpaces, type FileSpace, isDevtoolConfig } from './file-spaces.js'
import { DevtoolHttp } from './http.js'
import { DevtoolLB } from './lb.js'
import { DevtoolMcp, type McpLevelChange, type McpServerHost, type McpUiMessage } from '@appsys/devtool-mcp'
import { listPortOwners } from './ports.js'
import { DevtoolForgeItems } from './forge-items.js'
import type {
  AgentStartPayload,
  CommandStreamCreatePayload,
  CommandStreamInputPayload,
  CommandStreamPortConflictPayload,
  CommandStreamResizePayload,
  CommandStreamUpdatePayload,
  ConfigProvider,
  ConnectionMessage
} from './types.js'

const SCRIPT_CHANGE_DELAY_MS = 300

/**
 * Describes a file asked for in a file space that does not exist.
 * @param spaceId The identifier of the space.
 * @param filePath The path of the file.
 * @returns The file, with the error.
 */
function unknownSpaceFile (spaceId: string, filePath: string): FilePayload {
  return { space: spaceId, path: filePath, content: null, binary: false, updatedAt: null, saved: false, conflict: false, error: `${spaceId} is not a file space` }
}

export class DevtoolServer implements McpServerHost {
  private readonly configProvider: ConfigProvider

  readonly version: string

  private configWrapper: DevtoolConfigure

  public config: RuntimeConfig

  public http: DevtoolHttp

  private lb: DevtoolLB | null

  private commandStreams: DevtoolCommandStream[]

  private readonly cdnSession: DevtoolCdnSession

  readonly environment: DevtoolEnvironment

  readonly certificates: DevtoolCertificates

  readonly forgeItems: DevtoolForgeItems

  readonly fileSpaces = new DevtoolFileSpaces()

  private readonly mcp: DevtoolMcp

  private _scriptWatchers: FSWatcher[] = []

  private _scriptChangeTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * @param configProvider Loads the configuration.
   * @param version Version of the devtool.
   */
  private constructor (configProvider: ConfigProvider, version: string) {
    this.configProvider = configProvider
    this.version = version
    this.configWrapper = new DevtoolConfigure({})
    this.config = this.configWrapper.runtimeConfig
    this.http = null as unknown as DevtoolHttp
    this.lb = null
    this.commandStreams = []
    this.environment = new DevtoolEnvironment(payload => this.http.sendToWsConnections('environment', payload))
    this.cdnSession = new DevtoolCdnSession(async payload => {
      await this.http.sendToWsConnections('cdnSession', payload)
      if (!payload.pendingLoginUrl) {
        this.refreshEnvironment()
      }
    })
    this.certificates = new DevtoolCertificates({
      publish: async payload => {
        await this.http?.sendToWsConnections('certificates', payload)
      },
      run: (data, hooks) => this.newCommandStream(data, hooks),
      reload: () => this.reconfigure(),
      synchronizedPaths: files => this.environment.synchronizedPaths(files)
    })
    this.forgeItems = new DevtoolForgeItems({
      publish: async payload => {
        await this.http?.sendToWsConnections('forgeItems', payload)
      }
    })
    this.mcp = new DevtoolMcp(this)
  }

  /**
   * Gives the terminals of the server.
   * @returns The command streams, in the order they were started.
   */
  get streams (): readonly DevtoolCommandStream[] {
    return this.commandStreams
  }

  /**
   * Sends a payload to one interface, or to every interface.
   * @param type The type of the payload.
   * @param data The payload.
   * @param ws The connection of the interface, every connection when absent.
   */
  async publish (type: string, data: unknown, ws?: WebSocket): Promise<void> {
    await this.http?.sendToWsConnections(type, data, ws ?? null)
  }

  /**
   * Counts the open interfaces.
   * @returns Their number.
   */
  interfaces (): number {
    return this.http?.clientCount() ?? 0
  }

  /**
   * Lists the processes listening on a port of this machine.
   * @param port The port.
   * @returns Their identifiers and commands.
   */
  async portOwners (port: number): Promise<PortOwner[]> {
    return listPortOwners(port)
  }

  /**
   * Shows a message of an agent in every interface.
   * @param message The message.
   */
  async notifyUser (message: McpMessagePayload): Promise<void> {
    await this.publish('mcpMessage', message)
  }

  /**
   * Writes the levels of MCP settings changed from an interface, one after the other, to the personal
   * override or to the file declaring each, then reloads the configuration once; each failure is shown
   * in the interfaces.
   * @param changes The settings, their actions, their new levels and the files written.
   */
  async setMcpLevels (changes: McpLevelChange[]): Promise<void> {
    for (const change of changes) {
      try {
        const target = this.configWrapper.findMcpTarget(change.path)
        if (!target) {
          throw new Error(`${change.path.join('.')} is not an MCP setting`)
        }
        if (change.level !== null && !acceptsMcpLevel(target.path, change.action, change.level)) {
          throw new Error(`${change.level} does not fit ${target.path.join('.')}${change.action ? `.${change.action}` : ''}`)
        }
        const file = change.file === 'local' ? this.configWrapper.localPath : target.declaredIn
        if (!file) {
          throw new Error(change.file === 'local' ? 'no personal override is loaded' : 'no configuration file declares it')
        }
        await writeMcpLevel(file, target.path, change.action, change.level)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await this.notifyUser({ id: randomUUID(), client: 'devtool', message: `Permission not changed: ${message}`, level: 'error', date: Date.now() })
      }
    }
    await this.reconfigure()
  }

  /**
   * Writes how the sections, or the content of some sections, are ordered, changed from an interface,
   * to the personal override or to the file declaring each, then reloads the configuration once; each
   * failure is shown in the interfaces.
   * @param changes The lists ordered, their modes and orders, and the files written.
   */
  private async setSidebarOrder (changes: SidebarOrderChange[]): Promise<void> {
    for (const change of changes) {
      try {
        if (change.section !== null && !this.config.projects[change.section]) {
          throw new Error(`${change.section} is not a section`)
        }
        if (!SORT_MODES.includes(change.sort) || (change.order !== null && !(Array.isArray(change.order) && change.order.every(key => typeof key === 'string')))) {
          throw new Error(`${change.sort} is not a way to order the sidebar`)
        }
        const base = change.section === null ? ['adt', 'sidebar'] : ['sections', change.section]
        const file = change.file === 'local' ? this.configWrapper.localPath : this.configWrapper.settingTarget([...base, 'sort']).declaredIn
        if (!file) {
          throw new Error(change.file === 'local' ? 'no personal override is loaded' : 'no configuration file declares it')
        }
        await writeSetting(file, [...base, 'sort'], change.sort)
        await writeSetting(file, [...base, 'order'], change.order)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await this.notifyUser({ id: randomUUID(), client: 'devtool', message: `Order not changed: ${message}`, level: 'error', date: Date.now() })
      }
    }
    await this.reconfigure()
  }

  /**
   * Answers a request of an agent to the MCP server.
   * @param req The request.
   * @param res Its response.
   */
  async onMcpRequest (req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.mcp.handle(req, res)
  }

  /**
   * Loads the configuration and starts the server.
   * @param configProvider Loads the configuration.
   * @param version Version of the devtool.
   * @param loadBalancer Whether the load balancer runs in this process.
   * @returns The running server.
   */
  static async run (configProvider: ConfigProvider, version: string, loadBalancer: boolean): Promise<DevtoolServer> {
    const instance = new DevtoolServer(configProvider, version)
    await instance.loadConfig()
    await instance.createHttp()
    if (loadBalancer) {
      await instance.createLB()
    }
    await instance.listen()
    instance.certificates.start()
    instance.environment
      .refresh()
      .then(() => instance.environment.pullAtStartup())
      .catch((error: unknown) => {
        logger.warn('Server', 'Environment', `Not described or pulled at startup: ${error instanceof Error ? error.message : String(error)}`)
      })
    return instance
  }

  /**
   * Sends a new interface the configuration, the CDN sign-in state, the development environment, the
   * certificates, the pull requests and issues, the command streams and the agents; the pull requests
   * and issues are read from the first interface on.
   * @param ws The connection of the interface.
   */
  async onNewConnection (ws: WebSocket): Promise<void> {
    await this.http.sendToWsConnections('config', this.configWrapper.getForClient(this.version), ws)
    await this.http.sendToWsConnections('cdnSession', await this.cdnSession.status(), ws)
    await this.http.sendToWsConnections('environment', this.environment.state(), ws)
    await this.http.sendToWsConnections('certificates', this.certificates.state(), ws)
    await this.http.sendToWsConnections('forgeItems', this.forgeItems.state(), ws)
    this.forgeItems.start()
    for (const stream of this.commandStreams) {
      await stream.sendUpdate(ws)
      await stream.sendOutput(null, ws)
    }
    await this.mcp.sendTo(ws)
  }

  /**
   * Handles a message of an interface.
   * @param type The type of the message.
   * @param data Its payload.
   * @param ws The connection of the interface.
   */
  async onConnectionMessage (type: string, data: unknown, ws: WebSocket): Promise<void> {
    const message = { type, data } as ConnectionMessage

    if (message.type.startsWith('mcp')) {
      await this.mcp.onMessage(message as McpUiMessage)
      return
    }

    if (message.type === 'reconfigure') {
      await this.reconfigure()
      return
    }

    if (message.type === 'cdnLogin') {
      void this.cdnSession.login()
      return
    }

    if (message.type === 'cdnLogout') {
      await this.cdnSession.logout()
      return
    }

    if (message.type === 'certificateRenew') {
      await this.certificates.renew(message.data.name, message.data.tag)
      return
    }

    if (message.type === 'forgeItemsRefresh') {
      await this.forgeItems.refresh(message.data.key)
      return
    }

    if (message.type === 'forgeTimelineRead') {
      await this.http.sendToWsConnections('forgeTimeline', await this.forgeItems.timeline(message.data.key, message.data.number, message.data.before ?? null), ws)
      return
    }

    if (message.type === 'agentStart') {
      await this.startAgent(message.data)
      return
    }

    if (message.type === 'sidebarSetOrder') {
      await this.setSidebarOrder(message.data.changes)
      return
    }

    if (message.type === 'envRefresh') {
      this.refreshEnvironment()
      return
    }

    if (message.type === 'envPullConfig') {
      if (await this.environment.pullSharedConfig()) {
        await this.reconfigure()
      }
      return
    }

    if (message.type === 'envTables') {
      await this.http.sendToWsConnections('environmentTables', await this.environment.tables(message.data.path), ws)
      return
    }

    if (message.type === 'envKeys') {
      await this.http.sendToWsConnections('environmentKeys', await this.environment.keys(message.data.path), ws)
      return
    }

    if (message.type === 'envRun') {
      this.environment.run(message.data.direction, message.data.targets).catch((error: unknown) => {
        logger.warn('Server', 'Environment', `Run failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }

    if (message.type === 'envDismissRun') {
      await this.environment.dismissRun()
      return
    }

    if (message.type === 'filesList') {
      await this.sendFileTree(message.data.space, ws)
      return
    }

    if (message.type === 'fileRead') {
      const space = this.fileSpaces.get(message.data.space)
      await this.http.sendToWsConnections('file', space ? await space.read(message.data.path) : unknownSpaceFile(message.data.space, message.data.path), ws)
      return
    }

    if (message.type === 'fileWrite') {
      await this.writeFile(message.data.space, message.data.path, message.data.content, message.data.baseUpdatedAt, ws)
      return
    }

    if (message.type === 'fileCreate' || message.type === 'fileRemove' || message.type === 'fileRename') {
      const { data } = message
      const error = await this.changeFiles(data.space, space =>
        'kind' in data ? space.create(data.path, data.kind) : 'from' in data ? space.rename(data.from, data.to) : space.remove(data.path)
      )
      if (error) {
        await this.sendFileTree(data.space, ws, error)
      }
      return
    }

    if (message.type === 'newCommandStream') {
      await this.newCommandStream(message.data)
      return
    }

    if (message.type === 'newCommandDetached') {
      await this.newCommandDetached(message.data)
      return
    }

    if (message.type === 'updateCommandStream') {
      await this.updateCommandStream(message.data)
      return
    }

    if (message.type === 'portConflict') {
      await this.resolvePortConflict(message.data)
      return
    }

    if (message.type === 'streamInput') {
      await this.streamInput(message.data)
      return
    }

    if (message.type === 'streamResize') {
      await this.streamResize(message.data)
      return
    }

    logger.warn('Server', 'WS', `Unknown message type ${type}`)
    ws.send(JSON.stringify({ type: 'error', data: { message: `Unknown WS action type: ${type}` } }))
  }

  /**
   * Describes the development environment again in the background and publishes it.
   */
  private refreshEnvironment (): void {
    this.environment.refresh().catch((error: unknown) => {
      logger.warn('Server', 'Environment', `Not described: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * Sends the files of a space to one interface, or to every interface.
   * @param spaceId The identifier of the space.
   * @param ws The connection of the interface, every connection when omitted.
   * @param error Why a change of the files was refused, if it was.
   */
  private async sendFileTree (spaceId: string, ws?: WebSocket, error: string | null = null): Promise<void> {
    const space = this.fileSpaces.get(spaceId)
    const tree: FileTreePayload = space
      ? await space.tree()
      : { space: spaceId, root: '', exists: false, editable: false, entries: [], agentSkills: null, error: `${spaceId} is not a file space` }
    await this.http.sendToWsConnections('fileTree', error ? { ...tree, error } : tree, ws)
  }

  /**
   * Writes a file, sends its new state to the interface that asked, then, once written, the files of
   * its space to every interface before running what the space does after a write.
   * @param spaceId The identifier of the space.
   * @param filePath The path of the file.
   * @param content Its new content.
   * @param baseUpdatedAt Last change of the file the content was edited from.
   * @param ws The connection of the interface.
   */
  private async writeFile (spaceId: string, filePath: string, content: string, baseUpdatedAt: string | null, ws: WebSocket): Promise<void> {
    const space = this.fileSpaces.get(spaceId)
    const file = space ? await space.write(filePath, content, baseUpdatedAt) : unknownSpaceFile(spaceId, filePath)
    await this.http.sendToWsConnections('file', file, ws)
    if (file.saved) {
      await this.afterFileWrite(spaceId, filePath)
    }
  }

  /**
   * Sends the files of a space to every interface once one of them was written, then runs what the
   * space does after a write.
   * @param spaceId The identifier of the space.
   * @param filePath The path of the file written.
   */
  async afterFileWrite (spaceId: string, filePath: string): Promise<void> {
    await this.sendFileTree(spaceId)
    await this.fileSpaces.get(spaceId)?.afterWrite?.(filePath)
  }

  /**
   * Changes the files and folders of a space, then sends its files to every interface.
   * @param spaceId The identifier of the space.
   * @param change Changes the files of the space.
   * @returns Why the change was refused, null once done.
   */
  async changeFiles (spaceId: string, change: (space: FileSpace) => Promise<void>): Promise<string | null> {
    const space = this.fileSpaces.get(spaceId)
    if (!space) {
      return `${spaceId} is not a file space`
    }

    try {
      await change(space)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    await this.sendFileTree(spaceId)
    return null
  }

  /**
   * Watches the folders of scripts of the configuration, reloading it shortly after a file is added,
   * removed or renamed in one of them.
   */
  private watchScriptFolders (): void {
    for (const watcher of this._scriptWatchers) {
      watcher.close()
    }

    const folders = new Set(
      Object.values(this.config.projects).flatMap(project => Object.values(project.directories).flatMap(directory => directory.scripts.map(folder => folder.path)))
    )
    this._scriptWatchers = [...folders].map(folder =>
      watch(folder, event => {
        if (event !== 'rename') {
          return
        }
        if (this._scriptChangeTimer) {
          clearTimeout(this._scriptChangeTimer)
        }
        this._scriptChangeTimer = setTimeout(() => {
          this.reconfigure().catch((error: unknown) => {
            logger.warn('Server', 'Scripts', error instanceof Error ? error.message : String(error))
          })
        }, SCRIPT_CHANGE_DELAY_MS)
      }).on('error', error => logger.warn('Server', 'Scripts', `${folder}: ${error.message}`))
    )
  }

  /**
   * Reloads the configuration when a written configuration file belongs to the devtool one, then
   * describes the environment again.
   * @param filePath The path of the file in the configuration files space.
   */
  private async afterConfigWrite (filePath: string): Promise<void> {
    if (isDevtoolConfig(filePath)) {
      await this.reconfigure()
    }
    this.refreshEnvironment()
  }

  /**
   * Finds what the server does on its own around a command of the configuration.
   * @param projectSlug The project of the command.
   * @param directorySlug Its directory.
   * @param commandSlug The command.
   * @returns The automation, null when the command declares none.
   */
  commandAutomation (projectSlug: string, directorySlug: string, commandSlug: string): CommandAutomation | null {
    return this.configWrapper.automations[`${projectSlug}/${directorySlug}/${commandSlug}`] ?? null
  }

  /**
   * Forgets a closed terminal.
   * @param streamSlug The slug of the terminal.
   */
  async removeCommandStream (streamSlug: string): Promise<void> {
    this.commandStreams = this.commandStreams.filter(stream => stream.slug !== streamSlug)
    this.mcp.streamsChanged()
  }

  /**
   * Reloads the configuration, applies it to the load balancer when it runs in this process and sends it
   * to the interfaces.
   */
  async reconfigure (): Promise<void> {
    await this.loadConfig()
    if (this.lb && (await this.lb.reload(this.config))) {
      await this.lb.recreate()
    }
    await this.http.sendToWsConnections('config', this.configWrapper.getForClient(this.version))
    await this.cdnSession.publish()
  }

  /**
   * Starts a command in a terminal and keeps it among the streams of the server.
   * @param data The command.
   * @param hooks What the server adds to a command it starts itself.
   * @returns The terminal.
   */
  async newCommandStream (data: CommandStreamCreatePayload, hooks: CommandStreamHooks = {}): Promise<DevtoolCommandStream> {
    const stream = await DevtoolCommandStream.create(this, data, false, hooks)
    this.commandStreams.push(stream)
    this.mcp.streamsChanged()
    return stream
  }

  /**
   * Starts an agent of the configuration run by a command in a terminal of a project or of one of its
   * directories, its prompt given once the value blocks of the command are read, and shows the terminal
   * to the interface.
   * @param data The agent, the project and directory, the prompt and the terminal.
   */
  private async startAgent (data: AgentStartPayload): Promise<void> {
    const agent = this.config.adt.agents.find(item => item.slug === data.agent)
    const project = this.config.projects[data.projectSlug]
    if (!agent?.args || !project || (data.directorySlug !== null && !project.directories[data.directorySlug])) {
      logger.warn('Server', 'Agents', `No agent ${data.agent} run by a command in ${data.projectSlug}/${data.directorySlug ?? ''}`)
      return
    }
    await this.newCommandStream(
      {
        projectSlug: data.projectSlug,
        directorySlug: data.directorySlug,
        args: agent.args,
        env: agent.env,
        name: data.name,
        options: { redirect: true, values: { PROMPT: data.prompt } }
      },
      { automation: this.configWrapper.automations[agentAutomationKey(agent.slug)] ?? null }
    )
  }

  /**
   * Starts a command outside of any terminal, leaving it running on its own.
   * @param data The command.
   */
  async newCommandDetached (data: CommandStreamCreatePayload): Promise<void> {
    await DevtoolCommandStream.create(this, data, true)
  }

  private async updateCommandStream (data: CommandStreamUpdatePayload): Promise<void> {
    const stream = this.commandStreams.find(item => item.slug === data.streamSlug)
    if (!stream) {
      throw new Error('Command stream not found')
    }
    await stream.update({
      action: data.action,
      options: data.options
    })
  }

  /**
   * Stops the processes holding the port a command could not use, or forgets the conflict.
   * @param data The stream of the command and what to do.
   */
  private async resolvePortConflict (data: CommandStreamPortConflictPayload): Promise<void> {
    if (data.action !== 'kill' && data.action !== 'killAndRestart' && data.action !== 'dismiss') {
      return
    }
    await this.commandStreams.find(item => item.slug === data.streamSlug)?.resolvePortConflict(data.action)
  }

  private async streamInput (data: CommandStreamInputPayload): Promise<void> {
    const stream = this.commandStreams.find(item => item.slug === data.streamSlug)
    if (!stream) {
      return
    }
    stream.writeInput(data.data)
  }

  private async streamResize (data: CommandStreamResizePayload): Promise<void> {
    const stream = this.commandStreams.find(item => item.slug === data.streamSlug)
    if (!stream) {
      return
    }
    stream.resize(data.cols, data.rows)
  }

  /**
   * Loads the configuration and hands it to the CDN session, the environment, the certificates, the
   * pull requests and issues, the file spaces and the MCP server, then watches its folders of scripts.
   */
  private async loadConfig (): Promise<void> {
    const nextConfig = await this.configProvider()
    this.configWrapper = new DevtoolConfigure(nextConfig.raw, nextConfig.origin)
    await this.configWrapper.reconfigure()
    this.config = this.configWrapper.runtimeConfig
    this.cdnSession.configure(nextConfig.raw.cdn)
    this.environment.configure(nextConfig.raw)
    await this.certificates.configure(this.config, this.configWrapper.automations)
    this.forgeItems.configure(this.config, this.configWrapper.automations, this.configWrapper.integrationTokens)
    this.fileSpaces.configure(nextConfig.raw, this.config.projects, filePath => this.afterConfigWrite(filePath))
    await this.mcp.configure()
    this.watchScriptFolders()

    if (nextConfig.loadedPaths.length) {
      logger.info('Server', 'Config', `Loaded: ${nextConfig.loadedPaths.join(', ')}`)
    } else {
      logger.warn('Server', 'Config', 'No config file found')
    }
  }

  private async createHttp (): Promise<void> {
    this.http = await DevtoolHttp.create(this)
  }

  private async createLB (): Promise<void> {
    this.lb = await DevtoolLB.create(this)
  }

  /**
   * Starts listening on the server port, and on the load balancer port when it runs in this process.
   */
  private async listen (): Promise<void> {
    await this.http.listen()
    await this.lb?.listen()
  }
}
