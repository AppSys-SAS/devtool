import type { PortConflict, StreamUpdatePayload } from '@appsys-sas/devtool-shared'
import type { CommandStream } from '@/types'

export const STREAM_STATUS = {
  STOPPED: 'STOPPED',
  RUNNING: 'RUNNING',
  ERROR: 'ERROR'
} as const

export class CommandStreamStore implements CommandStream {
  slug = ''

  projectSlug: string | null = null

  directorySlug: string | null = null

  primary = false

  name = ''

  tag: string | null = null

  origin: string | null = null

  command: string | null = null

  args: string[] = []

  cwd = ''

  env: Record<string, string> = {}

  shell: string | null = null

  killSignal: string | null = null

  notifications = false

  creationDate = 0

  runningDate: number | null = null

  runningArgs: string[] | null = null

  stoppedDate: number | null = null

  exitCode: number | null = null

  portConflict: PortConflict | null = null

  status: CommandStream['status'] = STREAM_STATUS.STOPPED

  unread = false

  update (payload: StreamUpdatePayload): void {
    this.slug = payload.slug
    this.projectSlug = payload.projectSlug
    this.directorySlug = payload.directorySlug
    this.primary = payload.primary
    this.name = payload.name
    this.tag = payload.tag
    this.origin = payload.origin
    this.command = payload.command
    this.args = payload.args
    this.cwd = payload.cwd
    this.env = payload.env
    this.shell = payload.shell
    this.killSignal = payload.killSignal
    this.notifications = payload.notifications
    this.creationDate = payload.creationDate
    this.runningDate = payload.runningDate
    this.runningArgs = payload.runningArgs
    this.stoppedDate = payload.stoppedDate
    this.exitCode = payload.exitCode
    this.portConflict = payload.portConflict

    if (this.runningDate && !this.stoppedDate) {
      this.status = STREAM_STATUS.RUNNING
      return
    }

    if ((this.exitCode ?? 0) > 0) {
      this.status = STREAM_STATUS.ERROR
      return
    }

    this.status = STREAM_STATUS.STOPPED
  }
}
