import type { EventEmitter } from "node:events";
import type {
  CertificatePayload,
  CommandInputValue,
  ForgeItemsPayload,
  EnvironmentKeysPayload,
  EnvironmentPayload,
  EnvironmentTablesPayload,
  FileEntryPayload,
  FilePayload,
  FileTreePayload,
  McpAction,
  McpAnswer,
  McpLevel,
  McpMessagePayload,
  PortConflict,
  PortConflictAction,
  PortOwner,
  RuntimeConfig,
  StreamOutputLine,
} from "@appsys/devtool-shared";

/** What a terminal tells its listeners: each piece of output, each change of state, and its closing. */
export interface McpTerminalEvents {
  output: [StreamOutputLine];
  update: [];
  close: [];
}

/** A terminal of the devtool, as the tools of agents see and drive it. */
export interface McpTerminal {
  readonly slug: string;
  readonly name: string;
  /** The agent that started it, null when a person did. */
  readonly origin: string | null;
  /** The command of the configuration it runs, null for any other command. */
  readonly command: string | null;
  readonly projectSlug: string | null;
  readonly directorySlug: string | null;
  /** Whether it is the main terminal of its project. */
  readonly primary: boolean;
  readonly running: boolean;
  readonly exitCode: number | null;
  readonly cwd: string;
  readonly args: string[];
  readonly runningArgs: string[] | null;
  readonly portConflict: PortConflict | null;
  /** The output kept, the oldest pieces dropped beyond a limit. */
  readonly output: StreamOutputLine[];
  /** How many pieces of output were dropped from the start of `output`. */
  readonly outputStart: number;
  readonly size: { cols: number; rows: number };
  readonly events: EventEmitter<McpTerminalEvents>;
  screen(): Promise<string>;
  writeInput(data: string): void;
  update(update: { action: "start" | "stop" | "restart" | "close" }): Promise<void>;
  resize(cols: number, rows: number): void;
  resolvePortConflict(action: PortConflictAction): Promise<void>;
}

/** A command the tools of agents start in a terminal. */
export interface McpCommandStart {
  projectSlug: string | null;
  directorySlug: string | null;
  primary?: boolean;
  args: string[];
  env?: Record<string, string>;
  shell?: string | null;
  killSignal?: string | null;
  name: string;
  notifications: boolean;
  options: {
    command?: string;
    inputs?: CommandInputValue[];
    origin?: string;
    cwd?: string;
    restore?: boolean;
  };
}

/** A space of files of the devtool. */
export interface McpFileSpace {
  readonly root: string;
  /** Whether files and folders can be created, renamed and removed. */
  readonly editable: boolean;
  tree(): Promise<FileTreePayload>;
  read(filePath: string): Promise<FilePayload>;
  write(filePath: string, content: string, baseUpdatedAt: string | null): Promise<FilePayload>;
  create(filePath: string, kind: FileEntryPayload["kind"]): Promise<void>;
  remove(filePath: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/** The spaces of files of the devtool. */
export interface McpFileSpaces {
  /** The identifier of the space of the configuration files of the environment. */
  readonly configsSpace: string;
  get(id: string): McpFileSpace | null;
  /**
   * Tells whether a file of a space is the configuration of the devtool itself.
   * @param spaceId The identifier of the space.
   * @param filePath The path of the file in the space.
   * @returns True for the shared or personal configuration of the devtool.
   */
  holdsDevtoolConfig(spaceId: string, filePath: string): boolean;
}

/** The environment of the devtool synchronized with the CDN. */
export interface McpEnvironment {
  state(): EnvironmentPayload;
  keys(path: string): Promise<EnvironmentKeysPayload>;
  tables(path: string): Promise<EnvironmentTablesPayload>;
  run(direction: "pull" | "push", targets: { path: string; tables: string[] | null }[]): Promise<void>;
  pullSharedConfig(): Promise<boolean>;
}

/** The certificates of the load balancer. */
export interface McpCertificates {
  state(): CertificatePayload[];
  renew(name: string, tag: string | null): Promise<void>;
}

/** The open pull requests and issues of the integrations of the sections and projects. */
export interface McpForgeItems {
  state(): ForgeItemsPayload[];
}

/** What the tools of agents use from the devtool server. */
export interface McpHost {
  readonly config: RuntimeConfig;
  readonly streams: readonly McpTerminal[];
  readonly fileSpaces: McpFileSpaces;
  readonly environment: McpEnvironment;
  readonly certificates: McpCertificates;
  readonly forgeItems: McpForgeItems;
  newCommandStream(data: McpCommandStart, hooks?: { onExit?: (exitCode: number) => void }): Promise<McpTerminal>;
  newCommandDetached(data: McpCommandStart): Promise<void>;
  changeFiles(spaceId: string, change: (space: McpFileSpace) => Promise<void>): Promise<string | null>;
  afterFileWrite(spaceId: string, filePath: string): Promise<void>;
  reconfigure(): Promise<void>;
  notifyUser(message: McpMessagePayload): Promise<void>;
  portOwners(port: number): Promise<PortOwner[]>;
}

/** A level of an MCP setting changed from an interface, written to the personal override or the file declaring it. */
export interface McpLevelChange {
  path: string[];
  /** The action changed, null for a setting being a level itself. */
  action: McpAction | null;
  /** The new level, null to remove it so that it is inherited. */
  level: McpLevel | null;
  file: "local" | "declared";
}

/** What an interface asks about the agents: answers, grants, accepted agents, sessions, history, levels. */
export type McpUiMessage =
  | { type: "mcpAnswer"; data: { id: string; answer: McpAnswer; inputs?: CommandInputValue[] | null } }
  | { type: "mcpRevoke"; data: { key: string | null; scope: "session" | "always"; session?: string | null } }
  | { type: "mcpGrant"; data: { historyId: string; scope: "session" | "always" } }
  | { type: "mcpClient"; data: { name: string; decision: "always" | "forget" } }
  | { type: "mcpDisconnect"; data: { session: string } }
  | { type: "mcpClearHistory"; data: Record<string, never> }
  | { type: "mcpSetLevels"; data: { changes: McpLevelChange[] } };

/** What the MCP server needs from the devtool server, beyond what its tools use. */
export interface McpServerHost extends McpHost {
  readonly version: string;
  /**
   * Sends a payload to one interface, or to every interface.
   * @param type The type of the payload.
   * @param data The payload.
   * @param connection The interface, every interface when absent.
   */
  publish(type: string, data: unknown, connection?: unknown): Promise<void>;
  /** Counts the open interfaces. */
  interfaces(): number;
  /** Writes the levels of MCP settings changed from an interface, in order. */
  setMcpLevels(changes: McpLevelChange[]): Promise<void>;
}
