import type { ClientConfigPayload, ProjectDefinition, StreamUpdatePayload } from '@appsys/devtool-shared'

export type CommandStreamStatus = 'STOPPED' | 'RUNNING' | 'ERROR'

export interface CommandStream extends StreamUpdatePayload {
  status: CommandStreamStatus
  unread: boolean
}

export interface CommandStreamLine {
  type: 'stdout' | 'stderr' | 'stdin' | 'info'
  date: string
  content: string
}

export interface ConfigState {
  warnings: string[]
  loadBalancers: string[]
  projects: Record<string, ProjectDefinition> | null
}

export type WsConfigPayload = ClientConfigPayload
