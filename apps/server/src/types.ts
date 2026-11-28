import type { ConfigSources, RawConfig } from '@appsys-sas/devtool-config'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { McpUiMessage } from '@appsys-sas/devtool-mcp'
import type { CommandInputValue, EnvironmentAction, FileEntryPayload, PortConflictAction, RuntimeConfig, SidebarOrderChange } from '@appsys-sas/devtool-shared'
import type { WebSocket } from 'ws'
import type { EnvironmentTarget } from './environment.js'

export interface ServerBootstrapOptions {
  serverPort?: number
  loadBalancerPort?: number
  /** Port of the DNS, replacing `dns.port` of the configuration. */
  dnsPort?: number
  ssl?: string | null
  uiPath?: string | null
  configPaths?: string[]
  loadBalancer?: boolean
}

export interface LoadBalancerContext {
  config: RuntimeConfig
}

/** Where the settings of a configuration come from. */
export interface ConfigOrigin {
  /** The files declaring each setting, in the order they are merged. */
  sources: ConfigSources
  /** The personal override, loaded last, null when none is loaded. */
  localPath: string | null
  /** The first configuration file loaded besides the override, null when there is none. */
  sharedPath: string | null
}

export type ConfigProvider = () => Promise<{ raw: RawConfig, loadedPaths: string[], origin: ConfigOrigin }>

export interface CommandStreamCreatePayload {
  projectSlug?: string | null
  directorySlug?: string | null
  primary?: boolean
  args: string[]
  env?: Record<string, string> | null
  shell?: string | null
  killSignal?: string | null
  name?: string | null
  notifications?: boolean
  options?: {
    cwd?: string
    redirect?: boolean
    tag?: string
    /** A command of the directory in the configuration, whose arguments and automation are used. */
    command?: string
    /** The values typed for the inputs of the command, in order. */
    inputs?: CommandInputValue[]
    /** Runs the command of the configuration bringing back the folder of a missing project, or of its missing directory. */
    restore?: boolean
    /** The agent starting the command, absent for a person. */
    origin?: string
    /** The values of the variables `%{ADT:<NAME>}` of its arguments, replaced once their value blocks are read. */
    values?: Record<string, string>
  }
}

/** Asks to start an agent of the configuration with a prompt, in a terminal of a project or of one of its directories. */
export interface AgentStartPayload {
  /** The slug of the agent. */
  agent: string
  projectSlug: string
  /** The directory the agent works in, null for the project itself. */
  directorySlug: string | null
  prompt: string
  /** The name of the terminal. */
  name: string
}

export interface CommandStreamUpdatePayload {
  streamSlug: string
  action: 'start' | 'stop' | 'restart' | 'close'
  options?: {
    args?: string[]
  }
}

export interface CommandStreamInputPayload {
  streamSlug: string
  data: string
}

export interface CommandStreamResizePayload {
  streamSlug: string
  cols: number
  rows: number
}

/** Asks to free the port a command could not use, or to forget the conflict. */
export interface CommandStreamPortConflictPayload {
  streamSlug: string
  action: PortConflictAction
}

export type ConnectionMessage
  = | {
    type: 'reconfigure'
    data: Record<string, never>
  }
  | {
    type: 'authLogin'
    data: Record<string, never>
  }
  | {
    type: 'authLogout'
    data: Record<string, never>
  }
  | {
    type: 'secretAnswer'
    data: { id: string, value: string | null }
  }
  | {
    type: 'certificateRenew'
    data: { name: string, tag: string | null }
  }
  | {
    type: 'forgeItemsRefresh'
    data: { key: string }
  }
  | {
    type: 'forgeTimelineRead'
    /** `before`: where the events read start, as a previous part gave it, absent for the last events. */
    data: { key: string, number: number, before?: string | null }
  }
  | {
    type: 'agentStart'
    data: AgentStartPayload
  }
  | {
    type: 'sidebarSetOrder'
    data: { changes: SidebarOrderChange[] }
  }
  | {
    type: 'envRefresh'
    data: Record<string, never>
  }
  | {
    type: 'envPullConfig'
    data: Record<string, never>
  }
  | {
    type: 'envTables'
    data: { path: string }
  }
  | {
    type: 'envKeys'
    data: { path: string }
  }
  | {
    type: 'envRun'
    data: { action: EnvironmentAction, targets: EnvironmentTarget[], revision: number }
  }
  | {
    type: 'envCancel'
    data: { run: string, index: number | null }
  }
  | {
    type: 'envDismissRun'
    data: { run: string }
  }
  | {
    type: 'filesList'
    data: { space: string }
  }
  | {
    type: 'fileRead'
    data: { space: string, path: string }
  }
  | {
    type: 'fileWrite'
    data: { space: string, path: string, content: string, baseUpdatedAt: string | null }
  }
  | {
    type: 'fileCreate'
    data: { space: string, path: string, kind: FileEntryPayload['kind'] }
  }
  | {
    type: 'fileRemove'
    data: { space: string, path: string }
  }
  | {
    type: 'fileRename'
    data: { space: string, from: string, to: string }
  }
  | {
    type: 'newCommandStream'
    data: CommandStreamCreatePayload
  }
  | {
    type: 'updateCommandStream'
    data: CommandStreamUpdatePayload
  }
  | {
    type: 'newCommandDetached'
    data: CommandStreamCreatePayload
  }
  | {
    type: 'streamInput'
    data: CommandStreamInputPayload
  }
  | {
    type: 'streamResize'
    data: CommandStreamResizePayload
  }
  | {
    type: 'portConflict'
    data: CommandStreamPortConflictPayload
  }
  | McpUiMessage

export interface ServerContextLike {
  config: RuntimeConfig
  onNewConnection(ws: WebSocket): Promise<void>
  onConnectionMessage(type: string, data: unknown, ws: WebSocket): Promise<void>
  onMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void>
}
