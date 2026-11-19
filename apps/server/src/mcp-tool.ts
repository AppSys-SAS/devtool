import type { McpMessagePayload, RuntimeConfig } from "@appsys/devtool-shared";
import type { z } from "zod";
import type { DevtoolCertificates } from "./certificates.js";
import type { CommandStreamHooks, DevtoolCommandStream } from "./command-stream.js";
import type { DevtoolEnvironment } from "./environment.js";
import type { DevtoolFileSpaces, FileSpace } from "./file-spaces.js";
import type { McpAuthorization, McpPermission } from "./mcp-approvals.js";
import type { CommandStreamCreatePayload } from "./types.js";

/** What the tools of agents use from the server. */
export interface McpHost {
  readonly config: RuntimeConfig;
  readonly streams: readonly DevtoolCommandStream[];
  readonly fileSpaces: DevtoolFileSpaces;
  readonly environment: DevtoolEnvironment;
  readonly certificates: DevtoolCertificates;
  newCommandStream(data: CommandStreamCreatePayload, hooks?: CommandStreamHooks): Promise<DevtoolCommandStream>;
  newCommandDetached(data: CommandStreamCreatePayload): Promise<void>;
  changeFiles(spaceId: string, change: (space: FileSpace) => Promise<void>): Promise<string | null>;
  afterFileWrite(spaceId: string, filePath: string): Promise<void>;
  reconfigure(): Promise<void>;
  notifyUser(message: McpMessagePayload): Promise<void>;
}

/** A call of a tool by an agent. */
export interface McpCall {
  readonly session: string;
  readonly client: string;
  /**
   * Decides the call, asking a person when its rule says so.
   * @param permission What the call does and the rule of what it acts on.
   * @returns How it was allowed.
   */
  authorize(permission: McpPermission): Promise<McpAuthorization>;
  /**
   * Names what the call acts on in the history.
   * @param target What it acts on.
   * @param terminal The terminal it acts on or starts.
   */
  describe(target: string, terminal?: string | null): void;
}

/** A tool offered to agents. */
export interface McpTool {
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  /** Whether the tool only reads. */
  readOnly: boolean;
  run(input: Record<string, unknown>, call: McpCall): Promise<unknown>;
}

/**
 * Declares a tool, its input typed from its schema.
 * @param tool The tool.
 * @returns The tool as the MCP server registers it.
 */
export function defineTool<Shape extends z.ZodRawShape>(tool: {
  name: string;
  title: string;
  description: string;
  input: Shape;
  readOnly?: boolean;
  run(input: z.infer<z.ZodObject<Shape>>, call: McpCall): Promise<unknown>;
}): McpTool {
  return { ...tool, readOnly: tool.readOnly ?? false, run: (input, call) => tool.run(input as z.infer<z.ZodObject<Shape>>, call) };
}

/** An error an agent can fix: a missing terminal, command or file, an invalid value. */
export class McpToolError extends Error {}
