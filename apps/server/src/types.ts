import type { RawConfig } from "@appsys/devtool-config";
import type { RuntimeConfig } from "@appsys/devtool-shared";
import type { WebSocket } from "ws";

export interface ServerBootstrapOptions {
  serverPort?: number;
  loadBalancerPort?: number;
  ssl?: string | null;
  uiPath?: string | null;
  configPaths?: string[];
}

export type ConfigProvider = () => Promise<{ raw: RawConfig; loadedPaths: string[] }>;

export interface CommandStreamCreatePayload {
  projectSlug?: string | null;
  directorySlug?: string | null;
  primary?: boolean;
  args: string[];
  env?: Record<string, string> | null;
  name?: string | null;
  notifications?: boolean;
  options?: {
    cwd?: string;
    redirect?: boolean;
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

export type ConnectionMessage =
  | {
      type: "reconfigure";
      data: Record<string, never>;
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
    };

export interface ServerContextLike {
  config: RuntimeConfig;
  onNewConnection(ws: WebSocket): Promise<void>;
  onConnectionMessage(type: string, data: unknown, ws: WebSocket): Promise<void>;
}
