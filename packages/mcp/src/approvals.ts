import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  CommandInputValue,
  McpAction,
  McpAnswer,
  McpClientPayload,
  McpClientStatus,
  McpDecision,
  McpDetail,
  McpGrantPayload,
  McpHistoryEntry,
  McpPatterns,
  McpRequestPayload,
  McpRule,
  McpSessionPayload,
  McpSettings,
  McpStatePayload,
} from "@appsys/devtool-shared";
import { logger } from "@appsys/devtool-shared";

const HISTORY_LIMIT = 1000;
const GRANTS_FILE = "mcp-grants.json";
const CLIENTS_FILE = "mcp-clients.json";
const HISTORY_FILE = "mcp-history.jsonl";

/** A call an agent asks to make, as its tool describes it. */
export interface McpPermission {
  action: McpAction;
  /** The rule of what the call acts on. */
  rule: McpRule;
  /** Whether the call only touches the keys of a file, which the `keys` level allows. */
  keysOnly?: boolean;
  /** Whether a person answers even when the rule allows the call. */
  confirm?: boolean;
  title: string;
  details?: McpDetail[];
  keys?: string[];
  command?: string | null;
  inputs?: CommandInputValue[] | null;
  diff?: McpRequestPayload["diff"];
  /** Names what an answer for the session or always grants, absent when only this call can be granted. */
  grantKey?: string | null;
  grantLabel?: string;
  /** Whether the grant may outlive the session. */
  durable?: boolean;
}

/** How a call was allowed, with the inputs a person may have changed. */
export interface McpAuthorization {
  decision: McpDecision;
  inputs: CommandInputValue[] | null;
}

/** A call refused, by a person, the configuration, a timeout or the lack of an interface. */
export class McpRefusal extends Error {
  /**
   * @param decision How the call was refused.
   * @param message Why, as the agent reads it.
   * @param reason The setting refusing it, for a refusal by the configuration.
   */
  constructor(
    readonly decision: McpDecision,
    message: string,
    readonly reason: string | null = null,
  ) {
    super(message);
  }
}

/** What the approvals need from the server: publishing to the interfaces, counting them, its port. */
export interface McpApprovalsHost {
  publish(type: "mcpState" | "mcpHistory", data: unknown): Promise<void>;
  interfaces(): number;
  port(): number;
}

interface McpSession {
  id: string;
  client: string;
  version: string | null;
  connectedAt: number;
  calls: number;
  status: McpClientStatus;
  grants: Map<string, McpGrantPayload>;
  /** The request accepting the agent, while one waits. */
  acceptance: Promise<void> | null;
}

interface PendingRequest {
  payload: McpRequestPayload;
  settle: (answer: McpAnswer | "timeout", inputs: CommandInputValue[] | null) => void;
}

/**
 * Tells whether a text matches a pattern, `*` standing for any text.
 * @param pattern The pattern.
 * @param text The text.
 * @returns True when the whole text matches.
 */
export function matchesPattern(pattern: string, text: string): boolean {
  const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`, "s").test(text);
}

/**
 * Gives the level patterns set for a text: refused by `deny`, allowed by `allow`, else their level.
 * @param patterns The level and its patterns.
 * @param text The name or command line.
 * @param from Names the setting.
 * @returns The rule.
 */
export function patternRule(patterns: McpPatterns, text: string, from: string): McpRule {
  if (patterns.deny.some((pattern) => matchesPattern(pattern, text))) {
    return { level: "deny", from: `${from}.deny` };
  }
  if (patterns.allow.some((pattern) => matchesPattern(pattern, text))) {
    return { level: "allow", from: `${from}.allow` };
  }
  return { level: patterns.level, from: `${from}.level` };
}

/**
 * Decides the calls of agents: accepts the agents themselves, applies the rules of the configuration,
 * asks the interfaces when needed and keeps the grants and the history, those meant to last in the
 * cache folder.
 */
export class DevtoolApprovals {
  private readonly _host: McpApprovalsHost;

  private _settings: McpSettings | null = null;

  private _folder: string | null = null;

  private readonly _sessions = new Map<string, McpSession>();

  private _grants = new Map<string, McpGrantPayload>();

  private _clients = new Map<string, number>();

  private readonly _pending = new Map<string, PendingRequest>();

  private _history: McpHistoryEntry[] = [];

  private _writes: Promise<void> = Promise.resolve();

  /**
   * @param host Publishes to the interfaces and counts them.
   */
  constructor(host: McpApprovalsHost) {
    this._host = host;
  }

  /**
   * Applies the settings, reading the grants, accepted agents and history of the cache folder when it
   * changes.
   * @param settings The MCP settings.
   * @param cacheDir The cache folder of the devtool.
   */
  async configure(settings: McpSettings, cacheDir: string): Promise<void> {
    this._settings = settings;
    if (this._folder !== cacheDir) {
      this._folder = cacheDir;
      this._grants = new Map((await this.readJson<McpGrantPayload[]>(GRANTS_FILE, [])).map((grant) => [grant.key, grant]));
      this._clients = new Map(Object.entries(await this.readJson<Record<string, number>>(CLIENTS_FILE, {})));
      this._history = await this.readHistory();
    }
    for (const session of this._sessions.values()) {
      session.status = this.clientStatus(session.client, session.status);
    }
    await this.publishState();
  }

  /**
   * Starts following a session of an agent, accepted or not by its name.
   * @param id The session.
   * @param client The name the agent gives.
   * @param version The version it gives.
   */
  async openSession(id: string, client: string, version: string | null): Promise<void> {
    this._sessions.set(id, { id, client, version, connectedAt: Date.now(), calls: 0, status: this.clientStatus(client, "pending"), grants: new Map(), acceptance: null });
    await this.publishState();
  }

  /**
   * Forgets a session, its grants and its waiting requests, which are refused.
   * @param id The session.
   */
  async closeSession(id: string): Promise<void> {
    if (!this._sessions.delete(id)) {
      return;
    }
    for (const request of [...this._pending.values()].filter((item) => item.payload.session === id)) {
      request.settle("deny", null);
    }
    await this.publishState();
  }

  /**
   * Gives the name of the agent of a session.
   * @param id The session.
   * @returns Its name, `unknown` for a session not followed.
   */
  clientOf(id: string): string {
    return this._sessions.get(id)?.client ?? "unknown";
  }

  /**
   * Gives whether and how the agent of a session is accepted.
   * @param id The session.
   * @returns Its status, null for a session not followed.
   */
  statusOf(id: string): McpClientStatus | null {
    return this._sessions.get(id)?.status ?? null;
  }

  /**
   * Tells whether the agent of a session is accepted, without asking.
   * @param id The session.
   * @returns True when its calls may be decided.
   */
  isAccepted(id: string): boolean {
    const status = this._sessions.get(id)?.status;
    return status === "session" || status === "always" || status === "config";
  }

  /**
   * Decides a call: the agent accepted first, then the rule of what it acts on, a grant or the answer
   * of a person when the rule asks.
   * @param sessionId The session making the call.
   * @param tool The tool called.
   * @param permission The call.
   * @returns How it was allowed, with the inputs a person may have changed.
   * @throws {McpRefusal} When the call is refused.
   */
  async authorize(sessionId: string, tool: string, permission: McpPermission): Promise<McpAuthorization> {
    const session = await this.accept(sessionId, tool);
    const level = permission.rule.level === "keys" ? (permission.keysOnly ? "allow" : "deny") : permission.rule.level;
    if (level === "deny") {
      const why = permission.rule.level === "keys" ? "allows the keys of the file only" : "refuses it";
      throw new McpRefusal("config", `Refused: ${permission.rule.from} ${why}`, permission.rule.from);
    }
    if (level === "allow" && !permission.confirm) {
      return { decision: "auto", inputs: permission.inputs ?? null };
    }
    if (permission.grantKey && !permission.confirm) {
      if (session.grants.has(permission.grantKey)) {
        return { decision: "session", inputs: permission.inputs ?? null };
      }
      if (this._grants.has(permission.grantKey)) {
        return { decision: "always", inputs: permission.inputs ?? null };
      }
    }

    const grantKey = permission.confirm ? null : (permission.grantKey ?? null);
    const { answer, inputs } = await this.ask(session, {
      kind: "permission",
      tool,
      action: permission.action,
      title: permission.title,
      details: permission.details ?? [],
      keys: permission.keys ?? [],
      command: permission.command ?? null,
      inputs: permission.inputs ?? null,
      diff: permission.diff ?? null,
      grantKey,
      grantable: { session: grantKey !== null, always: grantKey !== null && permission.durable !== false },
    });
    if (answer === "timeout") {
      throw new McpRefusal("timeout", "Refused: nobody answered in time");
    }
    if (answer === "deny") {
      throw new McpRefusal("denied", "Refused by the user");
    }
    if (grantKey && answer !== "once") {
      this.addGrant(answer, grantKey, permission.grantLabel ?? permission.title, session);
    }
    return { decision: answer, inputs: inputs ?? permission.inputs ?? null };
  }

  /**
   * Adds a call to the history, publishes it and keeps it in the cache folder.
   * @param entry The call.
   */
  async record(entry: Omit<McpHistoryEntry, "id" | "date">): Promise<void> {
    const full: McpHistoryEntry = { id: randomUUID(), date: Date.now(), ...entry };
    const session = this._sessions.get(entry.session);
    if (session) {
      session.calls += 1;
    }
    this._history.push(full);
    const trimmed = this._history.length > HISTORY_LIMIT;
    if (trimmed) {
      this._history = this._history.slice(-HISTORY_LIMIT);
    }
    this.persist(HISTORY_FILE, () => (trimmed ? this.historyText() : null), `${JSON.stringify(full)}\n`);
    await this._host.publish("mcpHistory", { entries: [full], initial: false });
    if (session) {
      await this.publishState();
    }
  }

  /**
   * Answers a waiting request from an interface.
   * @param id The request.
   * @param answer The answer.
   * @param inputs The values of the inputs of its command, changed by the person.
   */
  answer(id: string, answer: McpAnswer, inputs: CommandInputValue[] | null): void {
    this._pending.get(id)?.settle(answer, inputs);
  }

  /**
   * Removes a grant, or every grant of a scope.
   * @param key The grant, null for all of them.
   * @param scope Whether it lasts for a session or always.
   * @param sessionId The session of a session grant, null for every session.
   */
  async revoke(key: string | null, scope: "session" | "always", sessionId: string | null): Promise<void> {
    if (scope === "always") {
      if (key === null) {
        this._grants.clear();
      } else {
        this._grants.delete(key);
      }
      this.saveGrants();
    } else {
      for (const session of this._sessions.values()) {
        if (sessionId === null || session.id === sessionId) {
          if (key === null) {
            session.grants.clear();
          } else {
            session.grants.delete(key);
          }
        }
      }
    }
    await this.publishState();
  }

  /**
   * Grants again what a call of the history asked, for its session when it is still open, or always.
   * @param historyId The call.
   * @param scope How long the grant lasts.
   */
  async grantFromHistory(historyId: string, scope: "session" | "always"): Promise<void> {
    const entry = this._history.find((item) => item.id === historyId);
    const session = entry ? this._sessions.get(entry.session) : undefined;
    if (!entry?.grantKey || (scope === "session" && !session)) {
      return;
    }
    this.addGrant(scope, entry.grantKey, entry.grantLabel ?? entry.tool, session ?? null, entry.client);
    await this.publishState();
  }

  /**
   * Accepts an agent always by its name, or forgets it, its open sessions then accepted for themselves.
   * @param name The name of the agent.
   * @param decision Whether it is accepted always or forgotten.
   */
  async setClient(name: string, decision: "always" | "forget"): Promise<void> {
    if (decision === "always") {
      this._clients.set(name, Date.now());
    } else {
      this._clients.delete(name);
    }
    this.persist(CLIENTS_FILE, () => JSON.stringify(Object.fromEntries(this._clients), null, 2));
    for (const session of this._sessions.values()) {
      if (session.client === name) {
        session.status = this.clientStatus(name, session.status === "always" ? "session" : session.status);
      }
    }
    await this.publishState();
  }

  /**
   * Empties the history, in the interfaces and the cache folder.
   */
  async clearHistory(): Promise<void> {
    this._history = [];
    this.persist(HISTORY_FILE, () => "");
    await this._host.publish("mcpHistory", { entries: [], initial: true });
  }

  /**
   * Gives the history.
   * @returns The calls, the oldest first.
   */
  history(): McpHistoryEntry[] {
    return this._history;
  }

  /**
   * Describes the sessions, agents, waiting requests and grants for the interfaces.
   * @returns The state.
   */
  state(): McpStatePayload {
    const settings = this._settings;
    const sessions: McpSessionPayload[] = [...this._sessions.values()].map(({ id, client, version, connectedAt, calls, status }) => ({ id, client, version, connectedAt, calls, status }));
    const clients: McpClientPayload[] = [
      ...(settings?.clients.allow ?? []).map((name) => ({ name, source: "allow" as const, date: null })),
      ...(settings?.clients.deny ?? []).map((name) => ({ name, source: "deny" as const, date: null })),
      ...[...this._clients].map(([name, date]) => ({ name, source: "always" as const, date })),
    ];
    return {
      enabled: settings?.enabled ?? false,
      port: this._host.port(),
      sessions,
      clients,
      pending: [...this._pending.values()].map((request) => request.payload),
      grants: [...[...this._sessions.values()].flatMap((session) => [...session.grants.values()]), ...this._grants.values()],
    };
  }

  /**
   * Publishes the state to every interface.
   */
  async publishState(): Promise<void> {
    await this._host.publish("mcpState", this.state());
  }

  /**
   * Gives the status of an agent from its name: refused, accepted always or by the configuration, else
   * the status it has.
   * @param client The name of the agent.
   * @param current Its current status.
   * @returns Its status.
   */
  private clientStatus(client: string, current: McpClientStatus): McpClientStatus {
    const clients = this._settings?.clients;
    if (!clients || clients.deny.some((pattern) => matchesPattern(pattern, client))) {
      return "denied";
    }
    if (this._clients.has(client)) {
      return "always";
    }
    if (clients.allow.some((pattern) => matchesPattern(pattern, client)) || clients.level === "allow") {
      return "config";
    }
    if (clients.level === "deny") {
      return "denied";
    }
    return current === "always" || current === "config" ? "pending" : current;
  }

  /**
   * Makes sure the agent of a session is accepted, asking a person once per session when its name is
   * neither known nor refused.
   * @param sessionId The session.
   * @param tool The tool whose call needs the agent accepted.
   * @returns The session.
   * @throws {McpRefusal} When the agent is refused or nobody accepts it.
   */
  async accept(sessionId: string, tool: string): Promise<McpSession> {
    const session = this._sessions.get(sessionId);
    if (!session) {
      throw new McpRefusal("denied", "Unknown session");
    }
    if (session.status === "denied") {
      throw new McpRefusal("denied", `Refused: the client ${session.client} is not accepted`);
    }
    if (session.status === "pending") {
      session.acceptance ??= this.askAcceptance(session, tool).finally(() => {
        session.acceptance = null;
      });
      await session.acceptance;
    }
    return session;
  }

  /**
   * Asks a person whether to accept the agent of a session.
   * @param session The session.
   * @param tool The tool whose call needs the agent accepted.
   * @throws {McpRefusal} When the agent is refused or nobody answers.
   */
  private async askAcceptance(session: McpSession, tool: string): Promise<void> {
    const { answer } = await this.ask(session, {
      kind: "client",
      tool,
      action: null,
      title: `New client: ${session.client}${session.version ? ` ${session.version}` : ""}`,
      details: [{ label: "Client", value: session.client }, ...(session.version ? [{ label: "Version", value: session.version }] : [])],
      keys: [],
      command: null,
      inputs: null,
      diff: null,
      grantKey: null,
      grantable: { session: true, always: true },
    });
    if (answer === "timeout") {
      throw new McpRefusal("timeout", `Refused: nobody accepted the client ${session.client} in time`);
    }
    if (answer === "deny") {
      session.status = "denied";
      await this.publishState();
      throw new McpRefusal("denied", `Refused: the user did not accept the client ${session.client}`);
    }
    if (answer === "always") {
      await this.setClient(session.client, "always");
      return;
    }
    session.status = "session";
    await this.publishState();
  }

  /**
   * Shows a request to the interfaces and waits for its answer, refusing it after the timeout or at
   * once when no interface is open.
   * @param session The session asking.
   * @param request The request, without what this method sets.
   * @returns The answer and the inputs changed by the person.
   * @throws {McpRefusal} When no interface is open.
   */
  private async ask(
    session: McpSession,
    request: Omit<McpRequestPayload, "id" | "session" | "client" | "notify" | "createdAt" | "expiresAt">,
  ): Promise<{ answer: McpAnswer | "timeout"; inputs: CommandInputValue[] | null }> {
    if (this._host.interfaces() === 0) {
      throw new McpRefusal("noUi", "Refused: no devtool interface is open to answer");
    }
    const timeout = (this._settings?.timeout ?? 120) * 1000;
    const payload: McpRequestPayload = {
      ...request,
      id: randomUUID(),
      session: session.id,
      client: session.client,
      notify: this._settings?.notifications ?? false,
      createdAt: Date.now(),
      expiresAt: Date.now() + timeout,
    };
    const result = await new Promise<{ answer: McpAnswer | "timeout"; inputs: CommandInputValue[] | null }>((resolve) => {
      const timer = setTimeout(() => settle("timeout", null), timeout);
      const settle = (answer: McpAnswer | "timeout", inputs: CommandInputValue[] | null): void => {
        clearTimeout(timer);
        this._pending.delete(payload.id);
        resolve({ answer, inputs });
      };
      this._pending.set(payload.id, { payload, settle });
      void this.publishState();
    });
    await this.publishState();
    return result;
  }

  /**
   * Grants a call for a session or always, the latter kept in the cache folder.
   * @param scope How long the grant lasts.
   * @param key Names what is granted.
   * @param label Describes it for a person.
   * @param session The session of the call, null when it is closed.
   * @param client The agent, when no session is given.
   */
  private addGrant(scope: "session" | "always", key: string, label: string, session: McpSession | null, client: string | null = null): void {
    const grant: McpGrantPayload = { key, label, scope, session: scope === "session" ? (session?.id ?? null) : null, client: session?.client ?? client, date: Date.now() };
    if (scope === "session" && session) {
      session.grants.set(key, grant);
      return;
    }
    this._grants.set(key, grant);
    this.saveGrants();
  }

  /**
   * Keeps the grants meant to last in the cache folder.
   */
  private saveGrants(): void {
    this.persist(GRANTS_FILE, () => JSON.stringify([...this._grants.values()], null, 2));
  }

  /**
   * Writes a file of the cache folder after the previous writes, replacing it, or appending a text
   * when no replacement is given.
   * @param name The name of the file.
   * @param content Gives the new content, null to append instead.
   * @param append The text appended when there is no new content.
   */
  private persist(name: string, content: () => string | null, append = ""): void {
    const folder = this._folder;
    if (!folder) {
      return;
    }
    const file = path.join(folder, name);
    this._writes = this._writes
      .then(async () => {
        await fs.mkdir(folder, { recursive: true });
        const text = content();
        await (text === null ? fs.appendFile(file, append) : fs.writeFile(file, text));
      })
      .catch((error: unknown) => {
        logger.warn("MCP", name, error instanceof Error ? error.message : String(error));
      });
  }

  /**
   * Gives the history as the lines of its file.
   * @returns One JSON entry per line.
   */
  private historyText(): string {
    return this._history.map((entry) => `${JSON.stringify(entry)}\n`).join("");
  }

  /**
   * Reads a JSON file of the cache folder.
   * @param name The name of the file.
   * @param fallback The value when it is missing or invalid.
   * @returns Its content.
   */
  private async readJson<T>(name: string, fallback: T): Promise<T> {
    if (!this._folder) {
      return fallback;
    }
    try {
      return JSON.parse(await fs.readFile(path.join(this._folder, name), "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  /**
   * Reads the history kept in the cache folder, its unreadable lines left out.
   * @returns The calls, the oldest first.
   */
  private async readHistory(): Promise<McpHistoryEntry[]> {
    if (!this._folder) {
      return [];
    }
    const text = await fs.readFile(path.join(this._folder, HISTORY_FILE), "utf8").catch(() => "");
    const entries: McpHistoryEntry[] = [];
    for (const line of text.split("\n")) {
      try {
        if (line.trim()) {
          entries.push(JSON.parse(line) as McpHistoryEntry);
        }
      } catch {
        continue;
      }
    }
    return entries.slice(-HISTORY_LIMIT);
  }
}
