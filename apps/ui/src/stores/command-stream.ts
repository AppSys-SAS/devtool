import type { StreamUpdatePayload } from "@appsys/devtool-shared";
import type { CommandStream } from "@/types";

export const STREAM_STATUS = {
  STOPPED: "STOPPED",
  RUNNING: "RUNNING",
  ERROR: "ERROR",
} as const;

export class CommandStreamStore implements CommandStream {
  slug = "";

  projectSlug: string | null = null;

  directorySlug: string | null = null;

  primary = false;

  name = "";

  args: string[] = [];

  cwd = "";

  env: Record<string, string> = {};

  killSignal: string | null = null;

  notifications = false;

  creationDate = 0;

  runningDate: number | null = null;

  runningArgs: string[] | null = null;

  stoppedDate: number | null = null;

  exitCode: number | null = null;

  status: CommandStream["status"] = STREAM_STATUS.STOPPED;

  unread = false;

  update(payload: StreamUpdatePayload): void {
    this.slug = payload.slug;
    this.projectSlug = payload.projectSlug;
    this.directorySlug = payload.directorySlug;
    this.primary = payload.primary;
    this.name = payload.name;
    this.args = payload.args;
    this.cwd = payload.cwd;
    this.env = payload.env;
    this.killSignal = payload.killSignal;
    this.notifications = payload.notifications;
    this.creationDate = payload.creationDate;
    this.runningDate = payload.runningDate;
    this.runningArgs = payload.runningArgs;
    this.stoppedDate = payload.stoppedDate;
    this.exitCode = payload.exitCode;

    if (this.runningDate && !this.stoppedDate) {
      this.status = STREAM_STATUS.RUNNING;
      return;
    }

    if ((this.exitCode ?? 0) > 0) {
      this.status = STREAM_STATUS.ERROR;
      return;
    }

    this.status = STREAM_STATUS.STOPPED;
  }
}
