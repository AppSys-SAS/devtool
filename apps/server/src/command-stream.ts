import { spawn as spawnDetached } from "node:child_process";
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn as spawnPty, type IPty } from "node-pty";
import treeKill from "tree-kill";
import type { StreamOutputLine, StreamUpdatePayload } from "@appsys/devtool-shared";
import { logger } from "@appsys/devtool-shared";
import type { WebSocket } from "ws";
import type { CommandStreamCreatePayload } from "./types.js";
import type { DevtoolServer } from "./server.js";

const MAX_OUTPUT = 2048;

function randomSlug(): string {
  const now = Date.now();
  return `${Math.random().toString(36).slice(2)}${now.toString(36)}`;
}

function shellEscapePosix(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function getShellCandidates(): string[] {
  const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].filter(
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

  public args: string[];

  public cwd: string;

  public env: Record<string, string>;

  public notifications: boolean;

  public runningDate: number | null;

  public runningArgs: string[] | null;

  public stoppedDate: number | null;

  public exitCode: number | null;

  public output: StreamOutputLine[];

  private proc: IPty | null;

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
    this.args = [];
    this.cwd = process.cwd();
    this.env = {};
    this.notifications = false;
    this.runningDate = null;
    this.runningArgs = null;
    this.stoppedDate = null;
    this.exitCode = null;
    this.output = [];
    this.proc = null;
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

  async create({
    projectSlug,
    directorySlug,
    primary = false,
    args,
    env = null,
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

    this.projectSlug = projectSlug ?? null;
    this.directorySlug = directorySlug ?? null;
    this.primary = primary;
    this.args = args;
    this.name = name ?? args.join(" ");
    this.cwd = cwd;
    this.env = env ?? {};
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

  async sendUpdate(wsInstance: WebSocket | null = null): Promise<void> {
    const payload: StreamUpdatePayload = {
      slug: this.slug,
      projectSlug: this.projectSlug,
      directorySlug: this.directorySlug,
      primary: this.primary,
      name: this.name,
      args: this.args,
      env: this.env,
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

  private async startDetached(): Promise<void> {
    ensureNodePtySpawnHelperExecutable();
    const args = this.convertArgs(this.args);
    const env = { ...process.env, ...this.defaultEnv, ...this.env };
    let child = null as ReturnType<typeof spawnDetached> | null;
    const spawnErrors: string[] = [];

    const directError = (() => {
      try {
        child = spawnDetached(args[0], args.slice(1), {
          cwd: this.cwd,
          env,
          detached: true,
          stdio: "ignore",
        });
        return null;
      } catch (error) {
        spawnErrors.push(`direct: ${error instanceof Error ? error.message : String(error)}`);
        return error;
      }
    })();

    if (!child) {
      if (process.platform === "win32") {
        throw new Error(
          `Unable to spawn detached command: ${args.join(" ")}${directError instanceof Error ? ` (${directError.message})` : ""}`,
        );
      }

      const command = args.map(shellEscapePosix).join(" ");
      for (const shell of getShellCandidates()) {
        if (!existsSync(shell)) {
          spawnErrors.push(`shell ${shell}: not found`);
          continue;
        }

        try {
          const flag = shell.includes("zsh") || shell.includes("bash") ? "-lic" : "-lc";
          child = spawnDetached(shell, [flag, command], {
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
          `Unable to spawn detached command in shells: ${args.join(" ")}${
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

  private convertArgs(args: string[]): string[] {
    if (!args.length) {
      throw new Error("Bad command args");
    }

    return args.map((item) => item.replace(/%\{GCE:CWD\}/g, this.cwd));
  }

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

    await this.addOutput("info", `Command: ${finalArgs.join(" ")}`);
    await this.addOutput("info", this.cwd);

    const spawnOptions = {
      cwd: this.cwd,
      env: { ...this.defaultEnv, ...process.env, ...this.env },
      cols: this.cols,
      rows: this.rows,
      name: "xterm-256color",
    } as const;

    const spawnErrors: string[] = [];

    try {
      this.proc = spawnPty(finalArgs[0], finalArgs.slice(1), spawnOptions);
    } catch (error) {
      spawnErrors.push(`direct: ${error instanceof Error ? error.message : String(error)}`);
      if (process.platform === "win32") {
        await this.handleStartFailure(
          new Error(
            `Unable to start command: ${finalArgs.join(" ")}${spawnErrors.length ? ` | attempts: ${spawnErrors.join(" || ")}` : ""}`,
          ),
        );
        await this.sendUpdate();
        return;
      }

      const command = finalArgs.map(shellEscapePosix).join(" ");
      for (const shell of getShellCandidates()) {
        if (!existsSync(shell)) {
          spawnErrors.push(`shell ${shell}: not found`);
          continue;
        }

        try {
          const flag = shell.includes("zsh") || shell.includes("bash") ? "-lic" : "-lc";
          this.proc = spawnPty(shell, [flag, command], spawnOptions);
          await this.addOutput("info", `Fallback shell: ${shell}`);
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

    this.proc.onData((data) => {
      void this.addOutput("stdout", data);
    });

    this.proc.onExit(({ exitCode }) => {
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
      this.runningArgs = null;

      void this.sendUpdate();
    });

    if (withUpdate) {
      await this.sendUpdate();
    }
  }

  private async handleStartFailure(error: unknown): Promise<void> {
    this.exitCode = 127;
    this.runningArgs = null;
    this.runningDate = Date.now();
    this.stoppedDate = Date.now();
    this.proc = null;

    const message = error instanceof Error ? error.message : "Unable to start process";
    await this.addOutput("stderr", message);
    await this.addOutput("info", "Process failed to start");
  }

  private async stop(): Promise<void> {
    if (!this.proc) {
      return;
    }

    await this.addOutput("info", "Killing the process...");
    this.stoppedDate = Date.now();
    const pid = this.proc.pid;

    await new Promise<void>((resolve, reject) => {
      treeKill(pid, "SIGTERM", (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }).catch(async (error) => {
      await this.addOutput("stderr", error instanceof Error ? error.message : "Unable to kill process");
      this.proc?.kill();
    });
  }

  private async restart(): Promise<void> {
    const args = this.runningArgs ?? this.args;
    await this.stop();
    await new Promise((resolve) => setTimeout(resolve, 150));
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
