import type { RawConfig } from "@appsys/devtool-config";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CommandInputValue, FileEntryPayload, McpAnswer, PortConflictAction, RuntimeConfig } from "@appsys/devtool-shared";
import type { WebSocket } from "ws";
import type { EnvironmentTarget } from "./environment.js";

export interface ServerBootstrapOptions {
  serverPort?: number;
  loadBalancerPort?: number;
  ssl?: string | null;
  uiPath?: string | null;
  configPaths?: string[];
  loadBalancer?: boolean;
}

export interface LoadBalancerContext {
  config: RuntimeConfig;
}

export type ConfigProvider = () => Promise<{ raw: RawConfig; loadedPaths: string[] }>;

export interface CommandStreamCreatePayload {
  projectSlug?: string | null;
  directorySlug?: string | null;
  primary?: boolean;
  args: string[];
  env?: Record<string, string> | null;
  shell?: string | null;
  killSignal?: string | null;
  name?: string | null;
  notifications?: boolean;
  options?: {
    cwd?: string;
    redirect?: boolean;
    tag?: string;
    /** A command of the directory in the configuration, whose arguments and automation are used. */
    command?: string;
    /** The values typed for the inputs of the command, in order. */
    inputs?: CommandInputValue[];
    /** Runs the command of the configuration bringing back the folder of a missing project, or of its missing directory. */
    restore?: boolean;
    /** The agent starting the command, absent for a person. */
    origin?: string;
  };
}

export interface CommandStreamUpdatePayload {
  streamSlug: string;
  action: "start" | "stop" | "restart" | "close";
  options?: {
    args?: string[];
  };
}

export interface CommandStreamInputPayload {
  streamSlug: string;
  data: string;
}

export interface CommandStreamResizePayload {
  streamSlug: string;
  cols: number;
  rows: number;
}

/** Asks to free the port a command could not use, or to forget the conflict. */
export interface CommandStreamPortConflictPayload {
  streamSlug: string;
  action: PortConflictAction;
}

export type ConnectionMessage =
  | {
      type: "reconfigure";
      data: Record<string, never>;
    }
  | {
      type: "cdnLogin";
      data: Record<string, never>;
    }
  | {
      type: "cdnLogout";
      data: Record<string, never>;
    }
  | {
      type: "certificateRenew";
      data: { name: string; tag: string | null };
    }
  | {
      type: "envRefresh";
      data: Record<string, never>;
    }
  | {
      type: "envPullConfig";
      data: Record<string, never>;
    }
  | {
      type: "envTables";
      data: { path: string };
    }
  | {
      type: "envKeys";
      data: { path: string };
    }
  | {
      type: "envRun";
      data: { direction: "pull" | "push"; targets: EnvironmentTarget[] };
    }
  | {
      type: "envDismissRun";
      data: Record<string, never>;
    }
  | {
      type: "filesList";
      data: { space: string };
    }
  | {
      type: "fileRead";
      data: { space: string; path: string };
    }
  | {
      type: "fileWrite";
      data: { space: string; path: string; content: string; baseUpdatedAt: string | null };
    }
  | {
      type: "fileCreate";
      data: { space: string; path: string; kind: FileEntryPayload["kind"] };
    }
  | {
      type: "fileRemove";
      data: { space: string; path: string };
    }
  | {
      type: "fileRename";
      data: { space: string; from: string; to: string };
    }
  | {
      type: "newCommandStream";
      data: CommandStreamCreatePayload;
    }
  | {
      type: "updateCommandStream";
      data: CommandStreamUpdatePayload;
    }
  | {
      type: "newCommandDetached";
      data: CommandStreamCreatePayload;
    }
  | {
      type: "streamInput";
      data: CommandStreamInputPayload;
    }
  | {
      type: "streamResize";
      data: CommandStreamResizePayload;
    }
  | {
      type: "portConflict";
      data: CommandStreamPortConflictPayload;
    }
  | McpUiMessage;

/** What an interface asks about the agents: answers, grants, accepted agents, sessions, history. */
export type McpUiMessage =
  | {
      type: "mcpAnswer";
      data: { id: string; answer: McpAnswer; inputs?: CommandInputValue[] | null };
    }
  | {
      type: "mcpRevoke";
      data: { key: string | null; scope: "session" | "always"; session?: string | null };
    }
  | {
      type: "mcpGrant";
      data: { historyId: string; scope: "session" | "always" };
    }
  | {
      type: "mcpClient";
      data: { name: string; decision: "always" | "forget" };
    }
  | {
      type: "mcpDisconnect";
      data: { session: string };
    }
  | {
      type: "mcpClearHistory";
      data: Record<string, never>;
    };

export interface ServerContextLike {
  config: RuntimeConfig;
  onNewConnection(ws: WebSocket): Promise<void>;
  onConnectionMessage(type: string, data: unknown, ws: WebSocket): Promise<void>;
  onMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
}
