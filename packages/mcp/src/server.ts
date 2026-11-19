import { randomUUID } from "node:crypto";
import type http from "node:http";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpDecision, McpDetail } from "@appsys/devtool-shared";
import { isLoopback, logger } from "@appsys/devtool-shared";
import { DevtoolApprovals, McpRefusal, type McpPermission } from "./approvals.js";
import { environmentTools } from "./environment.js";
import { fileTools } from "./files.js";
import type { McpServerHost, McpUiMessage } from "./host.js";
import { describeTerminal, readableTerminals, terminalLog, terminalTools } from "./terminals.js";
import { type McpCall, type McpTool, McpToolError } from "./tool.js";

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TERMINALS_URI = "devtool://terminals";
const TERMINAL_URI_PREFIX = "devtool://terminal/";
const RESOURCE_UPDATE_MS = 500;
const SESSION_IDLE_MS = 30 * 60_000;
const SESSION_GONE_MS = 30_000;
const SESSION_SWEEP_MS = 15_000;
const RESOURCE_LINES = 200;
const HISTORY_INPUT_LENGTH = 300;
const INSTRUCTIONS = [
  "Tools of the devtool, a local development environment: its terminals, the commands and scripts of its configuration, its files, its environment synchronized with a CDN and its certificates.",
  "Start with list_projects, list_commands and list_terminals. Prefer run_command (commands of the configuration) over run_shell.",
  "Read terminals with read_terminal, passing the returned cursor as `since` to get only new output; use mode `screen` for interactive prompts, then send_input.",
  "Some calls wait for the user to accept them in the devtool interface; a refused call returns an error saying why: do not retry it unchanged.",
].join("\n");

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  /** The terminals followed by the agent, by URI, with what stops following them. */
  subscriptions: Map<string, () => void>;
  /** When the agent last sent a request or closed one. */
  lastSeen: number;
  /** How many requests of the agent are still open: calls in progress and event streams. */
  open: number;
  /** Whether the agent listens on an event stream, which it keeps open as long as it runs. */
  listens: boolean;
}

/**
 * Reads the JSON body of a request.
 * @param req The request.
 * @returns The parsed body.
 */
async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Gives the host name of a `Host` or `Origin` header.
 * @param value The header.
 * @param withScheme Whether the header holds a scheme, as `Origin` does.
 * @returns The host name, null when it cannot be read.
 */
function hostnameOf(value: string | undefined, withScheme: boolean): string | null {
  try {
    return value ? new URL(withScheme ? value : `http://${value}`).hostname : null;
  } catch {
    return null;
  }
}

/**
 * The MCP server of the devtool: lets agents of this machine use its terminals, commands, files,
 * environment and certificates over Streamable HTTP, every call decided by {@link DevtoolApprovals}.
 */
export class DevtoolMcp {
  readonly approvals: DevtoolApprovals;

  private readonly _host: McpServerHost;

  private readonly _tools: McpTool[];

  private readonly _sessions = new Map<string, McpSession>();

  /**
   * @param host The devtool server.
   */
  constructor(host: McpServerHost) {
    this._host = host;
    this.approvals = new DevtoolApprovals({
      publish: (type, data) => host.publish(type, data),
      interfaces: () => host.interfaces(),
      port: () => host.config.adt.ports.server,
    });
    this._tools = [...terminalTools(host), ...fileTools(host), ...environmentTools(host)];
    setInterval(() => this.closeIdleSessions(), SESSION_SWEEP_MS).unref();
  }

  /**
   * Applies the configuration, closing every session when the server is disabled.
   */
  async configure(): Promise<void> {
    const { adt } = this._host.config;
    await this.approvals.configure(adt.mcp, adt.cacheDir);
    if (!adt.mcp.enabled) {
      await Promise.all([...this._sessions.values()].map((session) => session.transport.close()));
    }
  }

  /**
   * Answers a request of an agent on `/mcp`: only from this machine, never relayed by the load
   * balancer nor sent by a web page of another host.
   * @param req The request.
   * @param res Its response.
   */
  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this._host.config.adt.mcp.enabled) {
      res.writeHead(404).end("The MCP server is disabled (adt.mcp.enabled)");
      return;
    }
    const relayed = Object.keys(req.headers).some((name) => name.startsWith("x-forwarded-"));
    const origin = req.headers.origin;
    if (
      relayed ||
      !isLoopback(req.socket.remoteAddress) ||
      !LOCAL_HOSTNAMES.has(hostnameOf(req.headers.host, false) ?? "") ||
      (origin !== undefined && !LOCAL_HOSTNAMES.has(hostnameOf(origin, true) ?? ""))
    ) {
      res.writeHead(403).end("The MCP server only answers this machine");
      return;
    }

    let body: unknown;
    try {
      body = req.method === "POST" ? await readBody(req) : undefined;
    } catch {
      res.writeHead(400).end("Invalid JSON");
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    let session = typeof sessionId === "string" ? this._sessions.get(sessionId) : undefined;
    if (!session) {
      if (sessionId !== undefined || !isInitializeRequest(body)) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
        return;
      }
      session = await this.createSession();
    }
    const current = session;
    current.lastSeen = Date.now();
    current.open += 1;
    current.listens ||= req.method === "GET";
    res.once("close", () => {
      current.open -= 1;
      current.lastSeen = Date.now();
    });
    await current.transport.handleRequest(req, res, body);
  }

  /**
   * Closes the sessions of agents gone without saying so, once nothing of theirs is open: shortly after
   * an agent listening on an event stream lost it, after {@link SESSION_IDLE_MS} without a request for
   * the others. An agent coming back starts a new session.
   */
  private closeIdleSessions(): void {
    const now = Date.now();
    for (const session of this._sessions.values()) {
      if (session.open === 0 && session.lastSeen < now - (session.listens ? SESSION_GONE_MS : SESSION_IDLE_MS)) {
        void session.transport.close();
      }
    }
  }

  /**
   * Handles a message of an interface about the agents.
   * @param message The message.
   */
  async onMessage(message: McpUiMessage): Promise<void> {
    if (message.type === "mcpAnswer") {
      this.approvals.answer(message.data.id, message.data.answer, message.data.inputs ?? null);
    } else if (message.type === "mcpRevoke") {
      await this.approvals.revoke(message.data.key, message.data.scope, message.data.session ?? null);
    } else if (message.type === "mcpGrant") {
      await this.approvals.grantFromHistory(message.data.historyId, message.data.scope);
    } else if (message.type === "mcpClient") {
      await this.approvals.setClient(message.data.name, message.data.decision);
    } else if (message.type === "mcpDisconnect") {
      await this._sessions.get(message.data.session)?.transport.close();
    } else if (message.type === "mcpClearHistory") {
      await this.approvals.clearHistory();
    } else if (message.type === "mcpSetLevels") {
      await this._host.setMcpLevels(message.data.changes);
    }
  }

  /**
   * Sends the state of the agents and their history to a new interface.
   * @param connection The interface.
   */
  async sendTo(connection: unknown): Promise<void> {
    await this._host.publish("mcpState", this.approvals.state(), connection);
    await this._host.publish("mcpHistory", { entries: this.approvals.history(), initial: true }, connection);
  }

  /**
   * Tells the agents the list of terminals changed.
   */
  streamsChanged(): void {
    for (const session of this._sessions.values()) {
      session.server.sendResourceListChanged();
      if (session.subscriptions.has(TERMINALS_URI)) {
        void session.server.server.sendResourceUpdated({ uri: TERMINALS_URI });
      }
    }
  }

  /**
   * Creates the server and transport of a new session of an agent.
   * @returns The session, kept once its identifier is given.
   */
  private async createSession(): Promise<McpSession> {
    const server = new McpServer({ name: "devtool", version: this._host.version }, { capabilities: { resources: { subscribe: true, listChanged: true } }, instructions: INSTRUCTIONS });
    const session: McpSession = {
      server,
      subscriptions: new Map(),
      lastSeen: Date.now(),
      open: 0,
      listens: false,
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          this._sessions.set(id, session);
        },
      }),
    };
    session.transport.onclose = () => {
      const id = session.transport.sessionId;
      if (id) {
        void this.closeSession(id);
      }
    };
    server.server.oninitialized = () => {
      void this.openSession(session);
    };

    for (const tool of this._tools) {
      server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: { readOnlyHint: tool.readOnly } }, (input, extra) =>
        this.call(session, tool, input, extra.sessionId ?? "", extra.signal),
      );
    }
    this.registerResources(session);
    await server.connect(session.transport);
    return session;
  }

  /**
   * Starts following the agent of a session, once it said who it is.
   * @param session The session.
   */
  private async openSession(session: McpSession): Promise<void> {
    const id = session.transport.sessionId;
    const client = session.server.server.getClientVersion();
    if (id) {
      await this.approvals.openSession(id, client?.name ?? "unknown", client?.version ?? null, client?.title ?? null);
    }
  }

  /**
   * Stops following a session: its subscriptions, grants and waiting requests.
   * @param id The session.
   */
  private async closeSession(id: string): Promise<void> {
    const session = this._sessions.get(id);
    this._sessions.delete(id);
    for (const stop of session?.subscriptions.values() ?? []) {
      stop();
    }
    await this.approvals.closeSession(id);
  }

  /**
   * Runs a call of a tool: accepts the agent, runs the tool, which decides its own permissions, then
   * keeps the call in the history and answers the agent, a refusal or failure as an error.
   * @param session The session of the agent.
   * @param tool The tool.
   * @param input Its input.
   * @param sessionId The identifier of the session.
   * @param signal Aborted when the agent abandons the call.
   * @returns The answer to the agent.
   */
  private async call(
    session: McpSession,
    tool: McpTool,
    input: Record<string, unknown>,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
    if (this.approvals.clientOf(sessionId) === "unknown") {
      await this.openSession(session);
    }
    const started = Date.now();
    let waited = 0;
    let decision: McpDecision = "auto";
    let reason: string | null = null;
    let acceptance: "session" | "always" | null = null;
    let permission: McpPermission | null = null;
    let target: string | null = null;
    let terminal: string | null = null;
    const waitFor = async <T>(work: Promise<T>): Promise<T> => {
      const begin = Date.now();
      try {
        return await work;
      } finally {
        waited += Date.now() - begin;
      }
    };
    const call: McpCall = {
      session: sessionId,
      client: this.approvals.clientOf(sessionId),
      authorize: async (asked) => {
        permission = asked;
        const authorization = await waitFor(this.approvals.authorize(sessionId, tool.name, asked, signal));
        decision = authorization.decision;
        return authorization;
      },
      describe: (label, slug = null) => {
        target = label;
        terminal = slug ?? terminal;
      },
    };

    let ok = true;
    let text: string;
    try {
      const acceptedBefore = this.approvals.isAccepted(sessionId);
      await waitFor(this.approvals.accept(sessionId, tool.name));
      if (!acceptedBefore) {
        const status = this.approvals.statusOf(sessionId);
        acceptance = status === "session" || status === "always" ? status : null;
      }
      text = JSON.stringify(await tool.run(input, call), null, 2) ?? "null";
    } catch (error) {
      ok = false;
      if (error instanceof McpRefusal) {
        decision = error.decision;
        reason = error.reason;
      } else if (!(error instanceof McpToolError)) {
        logger.warn("MCP", tool.name, error instanceof Error ? error.message : String(error));
      }
      text = error instanceof Error ? error.message : String(error);
    }

    const asked = permission as McpPermission | null;
    await this.approvals.record({
      session: sessionId,
      client: call.client,
      tool: tool.name,
      target,
      action: asked?.action ?? null,
      details: (asked?.details ?? []).map((detail: McpDetail) => (detail.secret ? { label: detail.label, value: "(hidden)" } : detail)),
      grantKey: asked?.grantKey && !asked.confirm ? asked.grantKey : null,
      grantLabel: asked?.grantLabel ?? null,
      decision,
      reason,
      ok,
      message: ok ? null : text,
      input: Object.entries(input)
        .filter(([name]) => !tool.privateInput.includes(name))
        .map(([name, value]) => ({ label: name, value: (typeof value === "string" ? value : JSON.stringify(value)).slice(0, HISTORY_INPUT_LENGTH) })),
      duration: Date.now() - started,
      waited,
      acceptance,
      terminal,
    });
    return ok ? { content: [{ type: "text", text }] } : { content: [{ type: "text", text }], isError: true };
  }

  /**
   * Offers the terminals as resources an agent may read and follow.
   * @param session The session.
   */
  private registerResources(session: McpSession): void {
    const { server } = session;
    const accepted = (id: string | undefined): void => {
      if (!id || !this.approvals.isAccepted(id)) {
        throw new Error("The client is not accepted yet: call a tool first");
      }
    };
    server.registerResource("terminals", TERMINALS_URI, { title: "Terminals", mimeType: "application/json" }, (uri, extra) => {
      accepted(extra.sessionId);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(readableTerminals(this._host).map(describeTerminal), null, 2) }] };
    });
    server.registerResource(
      "terminal",
      new ResourceTemplate(`${TERMINAL_URI_PREFIX}{slug}`, {
        list: () => ({ resources: readableTerminals(this._host).map((stream) => ({ uri: `${TERMINAL_URI_PREFIX}${stream.slug}`, name: stream.name, mimeType: "application/json" })) }),
      }),
      { title: "Terminal", mimeType: "application/json" },
      (uri, variables, extra) => {
        accepted(extra.sessionId);
        const stream = readableTerminals(this._host).find((item) => item.slug === variables.slug);
        if (!stream) {
          throw new Error(`No terminal ${String(variables.slug)}`);
        }
        const content = { ...describeTerminal(stream), ...terminalLog(stream, undefined, RESOURCE_LINES) };
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(content, null, 2) }] };
      },
    );

    server.server.setRequestHandler(SubscribeRequestSchema, (request, extra) => {
      accepted(extra.sessionId);
      this.subscribe(session, request.params.uri);
      return {};
    });
    server.server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
      session.subscriptions.get(request.params.uri)?.();
      session.subscriptions.delete(request.params.uri);
      return {};
    });
  }

  /**
   * Follows a resource for an agent: the list of terminals, or a terminal whose changes are sent at
   * most every {@link RESOURCE_UPDATE_MS}.
   * @param session The session.
   * @param uri The resource.
   */
  private subscribe(session: McpSession, uri: string): void {
    if (session.subscriptions.has(uri)) {
      return;
    }
    if (uri === TERMINALS_URI) {
      session.subscriptions.set(uri, () => undefined);
      return;
    }
    const stream = readableTerminals(this._host).find((item) => `${TERMINAL_URI_PREFIX}${item.slug}` === uri);
    if (!stream) {
      throw new Error(`No terminal resource ${uri}`);
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const changed = (): void => {
      timer ??= setTimeout(() => {
        timer = null;
        void session.server.server.sendResourceUpdated({ uri });
      }, RESOURCE_UPDATE_MS);
    };
    const stop = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      stream.events.off("output", changed);
      stream.events.off("update", changed);
      stream.events.off("close", stop);
      session.subscriptions.delete(uri);
    };
    stream.events.on("output", changed);
    stream.events.on("update", changed);
    stream.events.on("close", stop);
    session.subscriptions.set(uri, stop);
  }
}
