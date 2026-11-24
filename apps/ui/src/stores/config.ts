import { ref } from 'vue'
import router from '@/router'
import type { AgentDefinition, ClientConfigPayload, IntegrationDefinition, ProjectDefinition, SidebarSettings, StreamUpdatePayload } from '@appsys/devtool-shared'
import { CommandStreamStore } from './command-stream'
import { CommandStreamOutputStore } from './command-stream-output'
import type { WsConfigPayload } from '@/types'

const HIDDEN_SIDEBAR: SidebarSettings = { environment: false, configs: false, login: false, sort: 'config', order: [], sections: [] }

class ConfigStore {
  /** The identifier of the devtool, such as the name of its MCP server, kept while disconnected. */
  name = ref('appsys-devtool')

  /** The name of the devtool shown to people, kept while disconnected. */
  displayName = ref('AppSys Devtool')

  /** When the configuration was last received, to fetch again what it may have changed. */
  loadedAt = ref(0)

  warnings = ref<string[]>([])

  loadBalancers = ref<string[]>([])

  integrations = ref<IntegrationDefinition[]>([])

  projects = ref<Record<string, ProjectDefinition> | null>(null)

  sidebar = ref<SidebarSettings>({ ...HIDDEN_SIDEBAR })

  /** The MCP server and the rules of agents, null before the configuration is received. */
  mcp = ref<ClientConfigPayload['mcp'] | null>(null)

  /** The AI agents the interface starts, in the order of the configuration. */
  agents = ref<AgentDefinition[]>([])

  commandStreams = ref<CommandStreamStore[]>([])

  commandStreamsOutput: Record<string, CommandStreamOutputStore> = {}

  loadConfig (config: WsConfigPayload | null): void {
    if (!config) {
      this.warnings.value = []
      this.loadBalancers.value = []
      this.integrations.value = []
      this.projects.value = null
      this.sidebar.value = { ...HIDDEN_SIDEBAR }
      this.mcp.value = null
      this.agents.value = []
      return
    }

    this.loadedAt.value = Date.now()
    this.name.value = config.name
    this.displayName.value = config.displayName
    this.warnings.value = config.warnings
    this.loadBalancers.value = config.loadBalancers
    this.integrations.value = config.integrations
    this.projects.value = config.projects
    this.sidebar.value = config.sidebar
    this.mcp.value = config.mcp
    this.agents.value = config.agents
  }

  reset (): void {
    this.loadConfig(null)
    this.commandStreams.value = []
    this.commandStreamsOutput = {}
  }

  streamUpdate (data: StreamUpdatePayload): void {
    let stream = this.commandStreams.value.find(item => item.slug === data.slug)
    if (!stream) {
      stream = new CommandStreamStore()
      stream.update(data)
      this.commandStreams.value.push(stream)

      const project = data.projectSlug ? this.projects.value?.[data.projectSlug] : null
      const directory = data.directorySlug && project ? project.directories[data.directorySlug] : null
      const defaultNotificationName = directory?.name ?? project?.name ?? null

      this.commandStreamsOutput[data.slug] = new CommandStreamOutputStore(defaultNotificationName)
      this.commandStreamsOutput[data.slug].update({
        slug: data.slug,
        name: data.name,
        projectSlug: data.projectSlug,
        directorySlug: data.directorySlug,
        primary: data.primary,
        notifications: data.notifications
      })
      return
    }

    stream.update(data)
    this.commandStreamsOutput[data.slug]?.update({
      slug: data.slug,
      name: data.name,
      projectSlug: data.projectSlug,
      directorySlug: data.directorySlug,
      primary: data.primary,
      notifications: data.notifications
    })
  }

  streamRemove (data: { slug: string }): void {
    this.commandStreams.value = this.commandStreams.value.filter(stream => stream.slug !== data.slug)
    delete this.commandStreamsOutput[data.slug]
  }

  streamRedirect ({ streamSlug }: { streamSlug: string }): void {
    const stream = this.commandStreams.value.find(item => item.slug === streamSlug)
    if (stream?.projectSlug && stream.directorySlug) {
      void router.push({
        name: 'directory-stream',
        params: {
          projectSlug: stream.projectSlug,
          directorySlug: stream.directorySlug,
          streamSlug
        }
      })
      return
    }

    if (stream?.projectSlug) {
      void router.push({
        name: 'project-stream',
        params: { projectSlug: stream.projectSlug, streamSlug }
      })
    }
  }

  streamOutput (data: { slug: string, output: { date: number, type: 'stdout' | 'stderr' | 'stdin' | 'info', content: string }[], initial: boolean }): void {
    const streamOutput = this.commandStreamsOutput[data.slug]
    if (!streamOutput) {
      return
    }

    const unread = streamOutput.addOutput(data.output, data.initial)
    if (!unread) {
      return
    }

    const commandStream = this.commandStreams.value.find(stream => stream.slug === data.slug)
    if (commandStream && !commandStream.unread) {
      commandStream.unread = true
    }
  }

  markAsRead (streamSlug: string): void {
    const commandStream = this.commandStreams.value.find(stream => stream.slug === streamSlug)
    if (commandStream?.unread) {
      commandStream.unread = false
    }
  }

  getProject (projectSlug: string): ProjectDefinition | null {
    const project = this.projects.value?.[projectSlug] ?? null
    if (!project) {
      void router.push({ name: 'dashboard' })
      return null
    }
    return project
  }

  getDirectory (projectSlug: string, directorySlug: string): { project: ProjectDefinition, directory: ProjectDefinition['directories'][string] } | null {
    const project = this.getProject(projectSlug)
    if (!project) {
      return null
    }

    const directory = project.directories[directorySlug]
    if (!directory) {
      void router.push({ name: 'project', params: { projectSlug } })
      return null
    }

    return {
      project,
      directory
    }
  }

  getAllCommandStreams (): CommandStreamStore[] {
    return this.commandStreams.value
  }

  getDirectoryStreamPrimary (projectSlug: string, directorySlug: string): string | null {
    const stream = this.commandStreams.value.find(
      item => item.projectSlug === projectSlug && item.directorySlug === directorySlug && item.primary === true
    )
    return stream?.slug ?? null
  }

  getCommandStream (streamSlug: string, projectSlug: string | null, directorySlug: string | null): CommandStreamStore | null {
    const stream = this.commandStreams.value.find(item => item.slug === streamSlug)
    if (stream) {
      return stream
    }

    if (directorySlug && projectSlug) {
      void router.push({ name: 'directory', params: { projectSlug, directorySlug } })
    } else if (projectSlug) {
      void router.push({ name: 'project', params: { projectSlug } })
    } else {
      void router.push({ name: 'dashboard' })
    }

    return null
  }

  getCommandStreamsOutput (streamSlug: string): CommandStreamOutputStore | null {
    return this.commandStreamsOutput[streamSlug] ?? null
  }
}

export default new ConfigStore()
