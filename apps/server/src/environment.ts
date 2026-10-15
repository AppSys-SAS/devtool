import {
  CdnClient,
  type CdnOptions,
  type CopyInfo,
  Environment,
  type EnvironmentOptions,
  type EnvironmentSelection,
  listTables,
  readCdnOptions,
  readEnvironmentOptions,
  SHARED_CONFIG_PATH,
} from "@appsys/devtool-cdn";
import type { RawConfig } from "@appsys/devtool-config";
import type {
  EnvironmentCopyPayload,
  EnvironmentItemPayload,
  EnvironmentKeyChoicePayload,
  EnvironmentKeysPayload,
  EnvironmentPayload,
  EnvironmentRunPayload,
  EnvironmentTablesPayload,
} from "@appsys/devtool-shared";

/** An item asked for by the interface, whole or restricted to some tables of a database or keys of a YAML file. */
export interface EnvironmentTarget {
  path: string;
  tables: string[] | null;
  keys?: EnvironmentKeyChoicePayload[] | null;
}

/**
 * Converts a copy description for the interface.
 *
 * @param copy - The copy.
 * @returns Its size and ISO date.
 */
function copyPayload(copy: CopyInfo): EnvironmentCopyPayload {
  return { size: copy.size, updatedAt: copy.updatedAt.toISOString() };
}

/**
 * Names a target the way the CLI does.
 *
 * @param target - The target.
 * @returns `<path>` or `<path>:<table>,<table>`.
 */
function targetName(target: EnvironmentTarget): string {
  if (target.keys) {
    return `${target.path} (${target.keys.length} ${target.keys.length > 1 ? "keys" : "key"} chosen)`;
  }

  return target.tables?.length ? `${target.path}:${target.tables.join(",")}` : target.path;
}

/**
 * Development environment of the developer as the interface shows it: the items with their local
 * and CDN copies, and the pulls and pushes it starts, one at a time.
 */
export class DevtoolEnvironment {
  private _cdn: CdnOptions | null = null;
  private _options: EnvironmentOptions | null = null;
  private _items: EnvironmentItemPayload[] = [];
  private _error: string | null = null;
  private _run: EnvironmentRunPayload | null = null;

  /**
   * @param _publish - Sends the state to every connected interface.
   */
  constructor(private readonly _publish: (payload: EnvironmentPayload) => Promise<void>) {}

  /**
   * Takes the `cdn` and `environment` sections of the configuration.
   *
   * @param config - The raw configuration.
   */
  configure(config: RawConfig): void {
    this._cdn = readCdnOptions(config.cdn);
    try {
      this._options = readEnvironmentOptions(config.environment);
      this._error = null;
    } catch (error) {
      this._options = null;
      this._error = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Describes the current state, as last refreshed.
   *
   * @returns The state.
   */
  state(): EnvironmentPayload {
    return { configured: this._cdn !== null && this._options !== null, items: this._items, error: this._error, run: this._run };
  }

  /**
   * Describes the items again and publishes the state.
   */
  async refresh(): Promise<void> {
    const environment = this.environment();
    if (environment) {
      const { items, remoteError } = await environment.describe();
      this._error = remoteError;
      this._items = items.map(({ item, local, remote, synced }) => ({
        path: item.path,
        kind: item.kind,
        engine: item.kind === "database" ? item.engine : null,
        container: item.kind === "database" ? item.container : null,
        bucket: item.kind === "bucket" ? item.bucket : null,
        local: local ? copyPayload(local) : null,
        remote: remote === "unknown" || remote === null ? remote : copyPayload(remote),
        synced: synced ? { localUpdatedAt: synced.localUpdatedAt.toISOString(), remoteUpdatedAt: synced.remoteUpdatedAt.toISOString() } : null,
      }));
    } else {
      this._items = [];
    }

    await this._publish(this.state());
  }

  /**
   * Downloads the shared devtool configuration, which declares the environment, and publishes why
   * it could not be downloaded, if it could not.
   *
   * @returns True when the configuration was downloaded.
   */
  async pullSharedConfig(): Promise<boolean> {
    if (!this._cdn) {
      return false;
    }

    try {
      const result = await new Environment(new CdnClient(this._cdn), { items: [], s3: null }).pull({ item: { kind: "file", path: SHARED_CONFIG_PATH }, tables: null });
      this._error = result.done ? null : `${SHARED_CONFIG_PATH} is not on the CDN`;
    } catch (error) {
      this._error = error instanceof Error ? error.message : String(error);
    }

    await this._publish(this.state());
    return this._error === null;
  }

  /**
   * Lists the tables of the local database of an item.
   *
   * @param path - The path of the item.
   * @returns The tables, or why they could not be listed.
   */
  async tables(path: string): Promise<EnvironmentTablesPayload> {
    const item = this._options?.items.find((candidate) => candidate.path === path);
    if (!item || item.kind !== "database") {
      return { path, tables: [], error: `${path} is not a database of the environment` };
    }

    try {
      return { path, tables: await listTables(item), error: null };
    } catch (error) {
      return { path, tables: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Lists the keys whose values differ between the local and CDN copies of a YAML item.
   *
   * @param path - The path of the item.
   * @returns The differing keys, or why they could not be listed.
   */
  async keys(path: string): Promise<EnvironmentKeysPayload> {
    const environment = this.environment();
    const item = this._options?.items.find((candidate) => candidate.path === path);
    if (!environment || !item || item.kind !== "file") {
      return { path, entries: [], error: `${path} is not a file of the environment` };
    }

    try {
      const differences = await environment.diffKeys(item);
      return {
        path,
        error: null,
        entries: differences.map((difference) => ({
          path: difference.path,
          local: { present: difference.local !== undefined, value: difference.local ?? null },
          remote: { present: difference.remote !== undefined, value: difference.remote ?? null },
        })),
      };
    } catch (error) {
      return { path, entries: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Pulls or pushes items one after the other, publishing the progress of each, then describes the
   * items again. A request while a run is in progress does nothing.
   *
   * @param direction - Whether the CDN copies replace the local ones, or the reverse.
   * @param targets - The items, with the tables of the databases and the keys of the YAML files.
   */
  async run(direction: "pull" | "push", targets: EnvironmentTarget[]): Promise<void> {
    const environment = this.environment();
    if (!environment || !this._options || (this._run && !this._run.finished)) {
      return;
    }

    const steps = targets.map((target) => ({ target: targetName(target), status: "pending" as const, detail: null }));
    const run: EnvironmentRunPayload = { direction, steps, finished: false };
    this._run = run;
    await this._publish(this.state());

    for (const [index, target] of targets.entries()) {
      const item = this._options.items.find((candidate) => candidate.path === target.path);
      run.steps[index] = { ...run.steps[index], status: "running" };
      await this._publish(this.state());
      try {
        if (!item) {
          throw new Error(`${target.path} is not part of the environment`);
        }

        const selection: EnvironmentSelection = {
          item,
          tables: item.kind === "database" && target.tables?.length ? target.tables : null,
          keys: item.kind === "file" && target.keys ? target.keys : null,
        };
        const result = await (direction === "pull" ? environment.pull(selection) : environment.push(selection));
        run.steps[index] = { ...run.steps[index], status: result.done ? "done" : "skipped", detail: result.detail };
      } catch (error) {
        run.steps[index] = { ...run.steps[index], status: "failed", detail: error instanceof Error ? error.message : String(error) };
      }
      await this._publish(this.state());
    }

    run.finished = true;
    await this.refresh();
  }

  /**
   * Builds the environment of the configuration.
   *
   * @returns The environment, or null when the configuration declares none or no CDN.
   */
  private environment(): Environment | null {
    return this._cdn && this._options ? new Environment(new CdnClient(this._cdn), this._options) : null;
  }
}
