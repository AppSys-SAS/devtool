import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IntegrationDefinition, PullRequestsPayload, RuntimeConfig } from "@appsys/devtool-shared";
import { logger } from "@appsys/devtool-shared";
import { findForge, ForgeError, repositoryOf } from "@appsys/devtool-git";
import { type CommandAutomation, CommandSecrets } from "./command-automation.js";
import { integrationAutomationKey } from "./configure.js";

const execFileAsync = promisify(execFile);
const MINUTE_MS = 60_000;

/** What the pull requests need from the server. */
export interface PullRequestsHost {
  /** Sends the state to every connected interface. */
  publish: (payload: PullRequestsPayload[]) => Promise<void>;
}

/** An integration listing pull requests, with what reading them needs. */
interface PullRequestsSource {
  integration: IntegrationDefinition;
  /** The folder of the project, where the value blocks of the token are read. */
  folder: string;
  /** The token, its value blocks not read yet, null for none. */
  token: string | null;
  automation: CommandAutomation | null;
}

/**
 * The open pull requests of the integrations of `type: pullRequests`, read on demand and every
 * `refresh` minutes once an interface asked for them, each token read once until the configuration
 * changes or the forge refuses it.
 */
export class DevtoolPullRequests {
  private _sources = new Map<string, PullRequestsSource>();
  private readonly _states = new Map<string, PullRequestsPayload>();
  private readonly _tokens = new Map<string, Promise<string | null>>();
  private _timers: NodeJS.Timeout[] = [];
  private _started = false;

  /**
   * @param _host What the pull requests need from the server.
   */
  constructor(private readonly _host: PullRequestsHost) {}

  /**
   * Takes the integrations of the configuration, reading their pull requests again once started.
   * @param config The runtime configuration.
   * @param automations The automations of the configuration.
   * @param tokens The tokens of the integrations, by key.
   */
  configure(config: RuntimeConfig, automations: Record<string, CommandAutomation>, tokens: Record<string, string>): void {
    this._sources = new Map();
    for (const [projectSlug, project] of Object.entries(config.projects)) {
      for (const [directorySlug, directory] of Object.entries(project.directories)) {
        for (const integration of directory.integrations.filter((item) => item.type === "pullRequests")) {
          const key = `${projectSlug}/${directorySlug}/${integration.slug}`;
          this._sources.set(key, { integration, folder: directory.path, token: tokens[key] ?? null, automation: automations[integrationAutomationKey(key)] ?? null });
        }
      }
    }
    for (const key of this._states.keys()) {
      if (!this._sources.has(key)) {
        this._states.delete(key);
      }
    }
    for (const key of this._sources.keys()) {
      this._states.set(key, this._states.get(key) ?? { key, items: [], viewer: null, updatedAt: null, loading: false, error: null });
    }
    this._tokens.clear();
    if (this._started) {
      this._started = false;
      this.start();
    } else {
      void this.publish();
    }
  }

  /**
   * Reads every pull request now, then every `refresh` minutes of its integration; does nothing once started.
   */
  start(): void {
    if (this._started) {
      return;
    }
    this._started = true;
    this._timers.forEach((timer) => clearInterval(timer));
    this._timers = [];
    for (const [key, source] of this._sources) {
      if (source.integration.refresh > 0) {
        this._timers.push(setInterval(() => void this.refresh(key), source.integration.refresh * MINUTE_MS).unref());
      }
      void this.refresh(key);
    }
  }

  /**
   * Describes the pull requests of every integration, as last read.
   * @returns The state.
   */
  state(): PullRequestsPayload[] {
    return [...this._states.values()];
  }

  /**
   * Reads the pull requests of an integration now, unless a read is running.
   * @param key The integration, `<section>/<project>/<slug>`.
   */
  async refresh(key: string): Promise<void> {
    const source = this._sources.get(key);
    const state = this._states.get(key);
    if (!source || !state || state.loading) {
      return;
    }

    this._states.set(key, { ...state, loading: true });
    await this.publish();
    let next: PullRequestsPayload;
    try {
      const repository = repositoryOf(source.integration.url);
      const forge = repository ? findForge(source.integration.provider?.name ?? null, repository) : null;
      if (!repository || !forge) {
        throw new Error(`no forge for ${source.integration.url}`);
      }
      const { viewer, items } = await forge.pullRequests(repository, await this.token(key, source));
      next = { key, items, viewer, updatedAt: new Date().toISOString(), loading: false, error: null };
    } catch (error) {
      if (error instanceof ForgeError && error.status === 401) {
        this._tokens.delete(key);
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Pull requests", key, message);
      next = { ...state, loading: false, error: message };
    }
    if (this._sources.get(key) === source) {
      this._states.set(key, next);
      await this.publish();
    }
  }

  /**
   * Gives the token of an integration, its value blocks read on first use.
   * @param key The integration.
   * @param source What reading its pull requests needs.
   * @returns The token, null when the integration declares none.
   */
  private token(key: string, source: PullRequestsSource): Promise<string | null> {
    let token = this._tokens.get(key);
    if (!token) {
      token = this.readToken(source);
      token.catch(() => this._tokens.delete(key));
      this._tokens.set(key, token);
    }
    return token;
  }

  /**
   * Reads the value blocks of the token of an integration, in the folder of its project.
   * @param source What reading its pull requests needs.
   * @returns The token, null when the integration declares none.
   */
  private async readToken(source: PullRequestsSource): Promise<string | null> {
    if (source.token === null) {
      return null;
    }
    const secrets = new CommandSecrets(source.automation?.opAccount ?? null, source.folder, async (command) => (await execFileAsync("/bin/sh", ["-c", command], { cwd: source.folder })).stdout);
    try {
      return await secrets.resolve(source.token);
    } finally {
      secrets.close();
    }
  }

  /**
   * Sends the state to every connected interface.
   */
  private async publish(): Promise<void> {
    await this._host.publish(this.state());
  }
}
