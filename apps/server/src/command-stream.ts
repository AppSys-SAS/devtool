import { spawn as spawnDetached } from "node:child_process";
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn as spawnPty, type IPty } from "node-pty";
import treeKill from "tree-kill";
import type { StreamOutputLine, StreamUpdatePayload } from "@appsys/devtool-shared";
import { logger } from "@appsys/devtool-shared";
import type { WebSocket } from "ws";
import { AnswerMatcher, type CommandAutomation, resolveCommand, type ResolvedCommand, scrub } from "./command-automation.js";
import type { CommandStreamCreatePayload } from "./types.js";
import type { DevtoolServer } from "./server.js";

const MAX_OUTPUT = 2048;
const STOP_TIMEOUT_MS = 10_000;
const ANSI_RESET = "\u001b[0m";
const ANSI_INFO_PREFIX = "\u001b[38;5;195m\u001b[48;5;27m";

function randomSlug(): string {
  const now = Date.now();
  return `${Math.random().toString(36).slice(2)}${now.toString(36)}`;
}

function shellEscapePosix(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function normalizeKillSignal(killSignal: string | null | undefined): string | null {
  if (typeof killSignal !== "string") {
    return null;
  }

  const normalized = killSignal.trim().toUpperCase();
  if (!normalized.length) {
    return null;
  }

  if (normalized.startsWith("SIG")) {
    return normalized;
  }

  return `SIG${normalized}`;
}

function normalizeShell(shell: string | null | undefined): string | null {
  if (typeof shell !== "string") {
    return null;
  }

  const normalized = shell.trim();
  if (!normalized.length) {
    return null;
  }

  return normalized;
}

function getShellCandidates(preferredShell: string | null = null): string[] {
  const candidates = [preferredShell, process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].filter(
    (item): item is string => Boolean(item && item.length),
  );

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    unique.push(candidate);
  }

  return unique;
}

function canAttemptShell(shell: string): boolean {
  if (!shell.includes(path.sep)) {
    return true;
  }

  return existsSync(shell);
}

function getShellArgs(shell: string, command: string): string[] {
  if (!command.length) {
    return [];
  }

  const flag = shell.includes("zsh") || shell.includes("bash") ? "-lic" : "-lc";
  return [flag, command];
}

/**
 * Compares the arguments of two commands.
 * @param left The arguments of the first command, null when there is no command.
 * @param right The arguments of the second command.
 * @returns True when both commands exist with the same arguments.
 */
function areArgsEqual(left: string[] | null, right: string[]): boolean {
  if (!left || left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

let didCheckNodePtyPermissions = false;

function ensureNodePtySpawnHelperExecutable(): void {
  if (didCheckNodePtyPermissions || process.platform !== "darwin") {
    return;
  }
  didCheckNodePtyPermissions = true;

  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("node-pty");
    const packageRoot = path.dirname(path.dirname(entry));
    const prebuildsDir = path.join(packageRoot, "prebuilds");

    if (!existsSync(prebuildsDir)) {
      return;
    }

    for (const directory of readdirSync(prebuildsDir)) {
      if (!directory.startsWith("darwin-")) {
        continue;
      }

      const spawnHelperPath = path.join(prebuildsDir, directory, "spawn-helper");
      if (!existsSync(spawnHelperPath)) {
        continue;
      }

      const mode = statSync(spawnHelperPath).mode;
      if ((mode & 0o111) !== 0) {
        continue;
      }

      chmodSync(spawnHelperPath, mode | 0o755);
    }
  } catch {
    // Silent fallback: spawn logic below will surface detailed errors if it still fails.
  }
}

export class DevtoolCommandStream {
  private readonly server: DevtoolServer;

  public readonly creationDate: number;

  public readonly slug: string;

  public projectSlug: string | null;

  public directorySlug: string | null;

  public primary: boolean;

  public name: string;

  /** Identifies the stream for the interface that started it. */
  public tag: string | null;

  private automation: CommandAutomation | null;

  public args: string[];

  public cwd: string;

  public env: Record<string, string>;

  public shell: string | null;

  public killSignal: string | null;

  public notifications: boolean;

  public runningDate: number | null;

  public runningArgs: string[] | null;

  public stoppedDate: number | null;

  public exitCode: number | null;

  public output: StreamOutputLine[];

  private proc: IPty | null;

  private exited: Promise<void> | null;

  private readonly defaultEnv: Record<string, string>;

  private cols: number;

  private rows: number;

  private constructor(server: DevtoolServer) {
    this.server = server;
    this.creationDate = Date.now();
    this.slug = randomSlug();
    this.projectSlug = null;
    this.directorySlug = null;
    this.primary = false;
    this.name = "N/A";
    this.tag = null;
    this.automation = null;
    this.args = [];
    this.cwd = process.cwd();
    this.env = {};
    this.shell = null;
    this.killSignal = null;
    this.notifications = false;
    this.runningDate = null;
    this.runningArgs = null;
    this.stoppedDate = null;
    this.exitCode = null;
    this.output = [];
    this.proc = null;
    this.exited = null;
    this.defaultEnv = {
      APPSYS_DEVTOOL: "true",
      FORCE_COLOR: "3",
      TERM: "xterm-256color",
    };
    this.cols = 120;
    this.rows = 30;
  }

  static async create(server: DevtoolServer, data: CommandStreamCreatePayload, detached = false): Promise<DevtoolCommandStream> {
    const instance = new DevtoolCommandStream(server);
    await instance.create(data);

    if (detached) {
      await instance.startDetached();
      return instance;
    }

    await instance.sendUpdate();
    if (data.options?.redirect) {
      await instance.sendToWsConnections("streamRedirect", { streamSlug: instance.slug });
    }
    await instance.start({ withUpdate: false });

    return instance;
  }

  /**
   * Describes the command of the stream; a command of the configuration brings its own arguments,
   * environment and automation, and the restore of a missing project runs in the parent of its folder.
   * @param data The command asked for by the interface.
   */
  async create({
    projectSlug,
    directorySlug,
    primary = false,
    args,
    env = null,
    shell = null,
    killSignal = null,
    name = null,
    notifications = false,
    options = {},
  }: CommandStreamCreatePayload): Promise<void> {
    let cwd = process.cwd();

    if (typeof options.cwd === "string") {
      cwd = options.cwd;
    } else if (projectSlug && this.server.config.projects[projectSlug]) {
      const project = this.server.config.projects[projectSlug];
      if (directorySlug && project.directories[directorySlug]) {
        cwd = project.directories[directorySlug].path;
      } else {
        cwd = project.path;
      }
    }

    const command = projectSlug && directorySlug && typeof options.command === "string" ? this.server.config.projects[projectSlug]?.directories[directorySlug]?.extras[options.command] : undefined;
    const missingProject = projectSlug && options.restore === true ? this.server.config.projects[projectSlug] : undefined;
    const restoreArgs = missingProject?.missing && missingProject.restore ? missingProject.restore.args.map((arg) => arg.replaceAll("%{ADT:PATH}", missingProject.path)) : null;
    if (restoreArgs && missingProject) {
      cwd = path.dirname(missingProject.path);
    }

    this.projectSlug = projectSlug ?? null;
    this.directorySlug = directorySlug ?? null;
    this.primary = primary;
    this.args = restoreArgs ?? command?.args ?? args;
    this.name = name ?? this.args.join(" ");
    this.tag = typeof options.tag === "string" ? options.tag : null;
    this.automation = command && projectSlug && directorySlug ? this.server.commandAutomation(projectSlug, directorySlug, command.slug) : null;
    this.cwd = cwd;
    this.env = command?.env ?? env ?? {};
    this.shell = normalizeShell(shell) ?? this.resolveShellFromConfig() ?? normalizeShell(this.server.config.adt.shell);
    this.killSignal = normalizeKillSignal(killSignal) ?? this.resolveKillSignalFromConfig();
    this.notifications = notifications;
    this.runningDate = Date.now();

    logger.info("Command", `${this.projectSlug ?? "global"}/${this.directorySlug ?? "-"}`, this.args.join(" "));
  }

  async update({
    action,
    options = {},
  }: {
    action: "start" | "stop" | "restart" | "close";
    options?: {
      args?: string[];
    };
  }): Promise<void> {
    logger.info("Command", `${this.projectSlug ?? "global"}/${this.directorySlug ?? "-"}`, `${action}: ${this.args.join(" ")}`);

    if (action === "start") {
      await this.start({ args: options.args ?? this.args });
      return;
    }

    if (action === "stop") {
      await this.stop();
      return;
    }

    if (action === "restart") {
      await this.restart();
      return;
    }

    if (action === "close") {
      await this.close();
    }
  }

  writeInput(data: string): void {
    if (!this.proc) {
      return;
    }
    this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
      return;
    }

    this.cols = cols;
    this.rows = rows;

    if (!this.proc) {
      return;
    }

    this.proc.resize(cols, rows);
  }

  /**
   * Sends the state of the stream to one interface, or to every interface.
   * @param wsInstance The connection of the interface, every connection when null.
   */
  async sendUpdate(wsInstance: WebSocket | null = null): Promise<void> {
    const payload: StreamUpdatePayload = {
      slug: this.slug,
      projectSlug: this.projectSlug,
      directorySlug: this.directorySlug,
      primary: this.primary,
      name: this.name,
      tag: this.tag,
      args: this.args,
      env: this.env,
      shell: this.shell,
      killSignal: this.killSignal,
      cwd: this.cwd,
      notifications: this.notifications,
      creationDate: this.creationDate,
      runningDate: this.runningDate,
      runningArgs: this.runningArgs,
      stoppedDate: this.stoppedDate,
      exitCode: this.exitCode,
    };

    await this.sendToWsConnections("streamUpdate", payload, wsInstance);
  }

  async sendOutput(output: StreamOutputLine | null = null, wsInstance: WebSocket | null = null): Promise<void> {
    await this.sendToWsConnections(
      "streamOutput",
      {
        slug: this.slug,
        output: output ? [output] : this.output,
        initial: wsInstance !== null,
      },
      wsInstance,
    );
  }

  private convertArgs(args: string[]): string[] {
    // noinspection RegExpRedundantEscape
    return args.map((item) => item.replace(/%\{ADT:CWD\}/g, this.cwd));
  }

  private async startDetached(): Promise<void> {
    ensureNodePtySpawnHelperExecutable();
    const finalArgs = this.convertArgs(this.args);
    const env = { ...process.env, ...this.defaultEnv, ...this.env };
    let child = null as ReturnType<typeof spawnDetached> | null;
    const spawnErrors: string[] = [];
    const preferredShell = normalizeShell(this.shell);

    if (!child) {
      if (process.platform === "win32") {
        throw new Error(
          `Unable to spawn detached command: ${finalArgs.join(" ")}${spawnErrors.length ? ` | attempts: ${spawnErrors.join(" || ")}` : ""}`,
        );
      }

      const command = finalArgs.map(shellEscapePosix).join(" ");
      for (const shell of getShellCandidates(preferredShell)) {
        if (!canAttemptShell(shell)) {
          spawnErrors.push(`shell ${shell}: not found`);
          continue;
        }

        try {
          child = spawnDetached(shell, getShellArgs(shell, command), {
            cwd: this.cwd,
            env,
            detached: true,
            stdio: "ignore",
          });
          break;
        } catch (error) {
          spawnErrors.push(`shell ${shell}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (!child) {
        throw new Error(
          `Unable to spawn detached command in shells: ${finalArgs.join(" ")}${
            spawnErrors.length ? ` | attempts: ${spawnErrors.join(" || ")}` : ""
          }`,
        );
      }
    }

    child.on("error", (error) => {
      logger.warn("CommandDetached", this.slug, error.message);
    });

    child.unref();
  }

  /**
   * Starts the process in a terminal and follows its output and exit.
   * @param options What to start.
   * @param options.withUpdate Whether the new state is sent to the interfaces once started.
   * @param options.args The arguments of the command.
   * @param options.notifications Whether the interfaces notify the end of the process.
   */
  private async start({
    withUpdate = true,
    args = this.args,
    notifications = this.notifications,
  }: {
    withUpdate?: boolean;
    args?: string[];
    notifications?: boolean;
  } = {}): Promise<void> {
    ensureNodePtySpawnHelperExecutable();
    const finalArgs = this.convertArgs(args);
    if (this.proc) {
      throw new Error("Command already running");
    }

    let resolved: ResolvedCommand | null = null;
    if (this.automation) {
      if (this.automation.unless && (await this.alreadyDone(this.automation.unless))) {
        await this.sendUpdate();
        return;
      }

      try {
        resolved = await resolveCommand(this.automation, finalArgs, this.env);
      } catch (error) {
        await this.handleStartFailure(error);
        await this.sendUpdate();
        return;
      }
    }

    await this.addOutput("info", finalArgs.length ? `Execute Command: ${finalArgs.join(" ")}\n` : "Execute Shell\n");
    // await this.addOutput("info", this.cwd);

    const spawnOptions = {
      cwd: this.cwd,
      env: { ...this.defaultEnv, ...process.env, ...(resolved?.env ?? this.env) },
      cols: this.cols,
      rows: this.rows,
      name: "xterm-256color",
    } as const;

    const spawnErrors: string[] = [];
    const preferredShell = normalizeShell(this.shell);

    if (!this.proc) {
      if (process.platform === "win32") {
        await this.handleStartFailure(
          new Error(
            `Unable to start command: ${finalArgs.join(" ")}${spawnErrors.length ? ` | attempts: ${spawnErrors.join(" || ")}` : ""}`,
          ),
        );
        await this.sendUpdate();
        return;
      }

      const command = (resolved?.args ?? finalArgs).map(shellEscapePosix).join(" ");
      for (const shell of getShellCandidates(preferredShell)) {
        if (!canAttemptShell(shell)) {
          spawnErrors.push(`shell ${shell}: not found`);
          continue;
        }

        try {
          this.proc = spawnPty(shell, getShellArgs(shell, command), spawnOptions);
          // await this.addOutput("info", `${preferredShell ? "Using shell" : "Using shell"}: ${shell}`);
          break;
        } catch (fallbackError) {
          spawnErrors.push(`shell ${shell}: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
        }
      }

      if (!this.proc) {
        await this.handleStartFailure(
          new Error(
            `Unable to start command: ${finalArgs.join(" ")}${spawnErrors.length ? ` | attempts: ${spawnErrors.join(" || ")}` : ""}`,
          ),
        );
        await this.sendUpdate();
        return;
      }
    }

    this.runningDate = Date.now();
    this.notifications = notifications;
    this.runningArgs = finalArgs;
    this.stoppedDate = null;
    this.exitCode = null;

    const answers = new AnswerMatcher(resolved?.answers ?? []);
    const secrets = resolved?.secrets ?? [];
    const proc = this.proc;
    proc.onData((data) => {
      const answer = answers.feed(data);
      if (answer !== null) {
        proc.write(`${answer}\r`);
      }
      void this.addOutput("stdout", scrub(data, secrets));
    });

    this.exited = new Promise<void>((resolve) => {
      proc.onExit(({ exitCode }) => {
        this.exitCode = exitCode;
        if (this.stoppedDate) {
          this.exitCode = 0;
          void this.addOutput("info", "Process killed");
        } else if (exitCode) {
          void this.addOutput("info", `Process exited with code ${exitCode}`);
        } else {
          void this.addOutput("info", "Process exited successfully");
        }

        this.stoppedDate = Date.now();
        this.proc = null;
        this.exited = null;
        this.runningArgs = null;

        void this.sendUpdate();
        resolve();
      });
    });

    if (withUpdate) {
      await this.sendUpdate();
    }
  }

  /**
   * Runs the command whose success makes the command needless, in the same shell, and when it
   * succeeds, shows its output and marks the command as done without starting it.
   * @param unless The arguments of the check.
   * @returns True when the check succeeded.
   */
  private async alreadyDone(unless: string[]): Promise<boolean> {
    const shell = getShellCandidates(normalizeShell(this.shell)).find(canAttemptShell);
    if (!shell) {
      return false;
    }

    const command = this.convertArgs(unless).map(shellEscapePosix).join(" ");
    const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawnDetached(shell, getShellArgs(shell, command), { cwd: this.cwd, env: { ...this.defaultEnv, ...process.env, ...this.env } });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.on("error", () => resolve({ code: null, output }));
      child.on("close", (code) => resolve({ code, output }));
    });
    if (result.code !== 0) {
      return false;
    }

    this.runningDate = Date.now();
    await this.addOutput("stdout", result.output.replace(/\r?\n/g, "\r\n"));
    await this.addOutput("info", `Skipped: ${unless.join(" ")} succeeded\n`);
    this.exitCode = 0;
    this.stoppedDate = Date.now();
    this.runningArgs = null;
    return true;
  }

  /**
   * Marks the command as failed before it could start, showing why.
   * @param error Why it could not start.
   */
  private async handleStartFailure(error: unknown): Promise<void> {
    this.exitCode = 127;
    this.runningArgs = null;
    this.runningDate = Date.now();
    this.stoppedDate = Date.now();
    this.proc = null;

    const message = error instanceof Error ? error.message : "Unable to start process";
    await this.addOutput("stderr", `${message}\r\n`);
    await this.addOutput("info", "Process failed to start");
  }

  private resolveKillSignalFromConfig(): string | null {
    if (!this.projectSlug || !this.directorySlug) {
      return null;
    }

    const project = this.server.config.projects[this.projectSlug];
    if (!project) {
      return null;
    }

    const directory = project.directories[this.directorySlug];
    if (!directory) {
      return null;
    }

    if (this.primary && areArgsEqual(directory.args, this.args)) {
      return normalizeKillSignal(directory.killSignal);
    }

    const extras = Object.values(directory.extras);
    for (const extra of extras) {
      if (extra.name === this.name && areArgsEqual(extra.args, this.args)) {
        return normalizeKillSignal(extra.killSignal);
      }
    }

    for (const extra of extras) {
      if (areArgsEqual(extra.args, this.args)) {
        return normalizeKillSignal(extra.killSignal);
      }
    }

    for (const extra of extras) {
      if (extra.name === this.name) {
        return normalizeKillSignal(extra.killSignal);
      }
    }

    return null;
  }

  private resolveShellFromConfig(): string | null {
    if (!this.projectSlug || !this.directorySlug) {
      return null;
    }

    const project = this.server.config.projects[this.projectSlug];
    if (!project) {
      return null;
    }

    const directory = project.directories[this.directorySlug];
    if (!directory) {
      return null;
    }

    if (this.primary && areArgsEqual(directory.args, this.args)) {
      return normalizeShell(directory.shell);
    }

    const extras = Object.values(directory.extras);
    for (const extra of extras) {
      if (extra.name === this.name && areArgsEqual(extra.args, this.args)) {
        return normalizeShell(extra.shell);
      }
    }

    for (const extra of extras) {
      if (areArgsEqual(extra.args, this.args)) {
        return normalizeShell(extra.shell);
      }
    }

    for (const extra of extras) {
      if (extra.name === this.name) {
        return normalizeShell(extra.shell);
      }
    }

    return normalizeShell(directory.shell);
  }

  /**
   * Stops the process and waits for it to exit, killing it when it outlives the stop timeout.
   */
  private async stop(): Promise<void> {
    if (!this.proc || !this.exited) {
      return;
    }

    const signal = normalizeKillSignal(this.killSignal) ?? this.resolveKillSignalFromConfig() ?? "SIGTERM";
    this.killSignal = signal;

    await this.addOutput("info", `Killing the process (${signal})...`);
    this.stoppedDate = Date.now();
    const exited = this.exited;
    await this.killTree(this.proc.pid, signal);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), STOP_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);

    if (timedOut && this.proc) {
      await this.addOutput("info", `Still running after ${STOP_TIMEOUT_MS / 1000}s, killing the process (SIGKILL)...`);
      await this.killTree(this.proc.pid, "SIGKILL");
      await exited;
    }
  }

  /**
   * Sends a signal to a process and its descendants, falling back to the process alone.
   * @param pid The process.
   * @param signal The signal.
   */
  private async killTree(pid: number, signal: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      treeKill(pid, signal, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }).catch(async (error: unknown) => {
      await this.addOutput("stderr", error instanceof Error ? error.message : "Unable to kill process");
      this.proc?.kill(signal);
    });
  }

  /**
   * Stops the process, waits for it to exit, then starts it again with the same arguments.
   */
  private async restart(): Promise<void> {
    const args = this.runningArgs ?? this.args;
    await this.stop();
    await this.addOutput("info", "Restarting process...");
    await this.start({ args });
  }

  private async close(): Promise<void> {
    if (this.proc) {
      throw new Error("Process not stopped");
    }
    await this.server.removeCommandStream(this.slug);
    await this.sendToWsConnections("streamRemove", { slug: this.slug });
  }

  private async addOutput(type: StreamOutputLine["type"], content: string): Promise<void> {
    if (type === "info") {
      content = `${ANSI_INFO_PREFIX}${content}${ANSI_RESET}`;
    }

    const output: StreamOutputLine = {
      date: Date.now(),
      type,
      content,
    };

    this.output.push(output);
    await this.sendOutput(output);

    while (this.output.length > MAX_OUTPUT) {
      this.output.shift();
    }
  }

  private async sendToWsConnections(type: string, data: unknown, wsInstance: WebSocket | null = null): Promise<void> {
    await this.server.http.sendToWsConnections(type, data, wsInstance);
  }
}
