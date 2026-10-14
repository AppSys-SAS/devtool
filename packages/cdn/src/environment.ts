import fs from "node:fs/promises";
import path from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import { ArchiveWriter, readArchive } from "./archive.js";
import { createS3Client, restoreBucket, type S3Options, snapshotBucket } from "./buckets.js";
import type { CdnClient } from "./client.js";
import { localPathOf } from "./directory.js";
import { databaseEngine, type DatabaseEngineName, isDatabaseEngineName } from "./engines.js";

/** Path of the shared devtool configuration, always part of the environment. */
export const SHARED_CONFIG_PATH = "devtool/config.yml";

/** A file of the environment: a configuration, a database archive or a bucket snapshot. */
export type EnvironmentItem =
  | { kind: "file"; path: string }
  | { kind: "database"; path: string; engine: DatabaseEngineName; container: string }
  | { kind: "bucket"; path: string; bucket: string };

/** What the environment is made of, as declared in the `environment` section of the configuration. */
export interface EnvironmentOptions {
  items: EnvironmentItem[];
  s3: S3Options | null;
}

/** An item to transfer, whole or, for a database, restricted to some tables. */
export interface EnvironmentSelection {
  item: EnvironmentItem;
  tables: string[] | null;
}

/** Outcome of the transfer of one item. */
export interface TransferResult {
  done: boolean;
  detail: string;
}

/**
 * Reads a record of the configuration.
 *
 * @param value - The raw value.
 * @returns The record, empty when the value is not one.
 */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Reads a list of records of the configuration.
 *
 * @param value - The raw value.
 * @returns The records.
 */
function recordsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(recordOf) : [];
}

/**
 * Reads the `environment` section of the devtool configuration.
 *
 * @param section - The raw section.
 * @returns The environment, or null when the section is missing.
 */
export function readEnvironmentOptions(section: unknown): EnvironmentOptions | null {
  if (typeof section !== "object" || section === null) {
    return null;
  }

  const record = recordOf(section);
  const items: EnvironmentItem[] = [{ kind: "file", path: SHARED_CONFIG_PATH }];
  for (const file of Array.isArray(record.files) ? record.files : []) {
    if (typeof file === "string" && file !== SHARED_CONFIG_PATH) {
      items.push({ kind: "file", path: file });
    }
  }
  for (const database of recordsOf(record.databases)) {
    if (typeof database.path !== "string" || !isDatabaseEngineName(database.engine) || typeof database.container !== "string") {
      throw new Error(`invalid database in the environment: ${JSON.stringify(database)}`);
    }
    items.push({ kind: "database", path: database.path, engine: database.engine, container: database.container });
  }
  for (const bucket of recordsOf(record.buckets)) {
    if (typeof bucket.path !== "string" || typeof bucket.bucket !== "string") {
      throw new Error(`invalid bucket in the environment: ${JSON.stringify(bucket)}`);
    }
    items.push({ kind: "bucket", path: bucket.path, bucket: bucket.bucket });
  }

  const s3 = recordOf(record.s3);
  return {
    items,
    s3:
      typeof s3.endpoint === "string" && typeof s3.accessKeyId === "string" && typeof s3.secretAccessKey === "string"
        ? { endpoint: s3.endpoint, accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey, region: typeof s3.region === "string" ? s3.region : "us-east-1" }
        : null,
  };
}

/**
 * Reads targets given as `<path>` or `<path>:<table>,<table>`.
 *
 * @param options - The environment.
 * @param targets - The targets.
 * @returns The selections, every item when no target is given.
 */
export function parseTargets(options: EnvironmentOptions, targets: string[]): EnvironmentSelection[] {
  if (targets.length === 0) {
    return options.items.map((item) => ({ item, tables: null }));
  }

  return targets.map((target) => {
    const separator = target.indexOf(":");
    const itemPath = separator < 0 ? target : target.slice(0, separator);
    const item = options.items.find((candidate) => candidate.path === itemPath);
    if (!item) {
      throw new Error(`${itemPath} is not part of the environment (${options.items.map((candidate) => candidate.path).join(", ")})`);
    }

    if (separator < 0) {
      return { item, tables: null };
    }

    if (item.kind !== "database") {
      throw new Error(`${itemPath} has no tables`);
    }

    const tables = target.slice(separator + 1).split(",").map((table) => table.trim()).filter((table) => table !== "");
    return { item, tables: tables.length > 0 ? tables : null };
  });
}

/**
 * Lists the tables of the local database of an item.
 *
 * @param item - The database item.
 * @returns The tables.
 */
export async function listTables(item: Extract<EnvironmentItem, { kind: "database" }>): Promise<string[]> {
  return databaseEngine(item.engine).listTables(item.container);
}

/**
 * Tells whether pulling a selection overwrites local data.
 *
 * @param selection - The selection.
 * @returns True for databases and buckets.
 */
export function overwritesLocalData(selection: EnvironmentSelection): boolean {
  return selection.item.kind !== "file";
}

/**
 * Gives the media type of a file of the environment.
 *
 * @param filePath - The path of the file.
 * @returns The media type.
 */
function mediaTypeOf(filePath: string): string {
  return filePath.endsWith(".yml") ? "application/yaml" : filePath.endsWith(".gz") ? "application/gzip" : "application/octet-stream";
}

/**
 * Checks that every requested table exists.
 *
 * @param tables - The requested tables.
 * @param known - The tables found.
 * @param where - Where they were looked for.
 */
function assertKnownTables(tables: string[], known: Iterable<string>, where: string): void {
  const knownTables = new Set(known);
  const unknown = tables.filter((table) => !knownTables.has(table));
  if (unknown.length > 0) {
    throw new Error(`unknown tables in ${where}: ${unknown.join(", ")}`);
  }
}

/**
 * The local environment of the developer, kept in sync with the devtool files of the CDN.
 */
export class Environment {
  private _s3: S3Client | null = null;

  /**
   * @param _client - The client of the devtool files of the CDN.
   * @param _options - The environment.
   */
  constructor(
    private readonly _client: CdnClient,
    private readonly _options: EnvironmentOptions,
  ) {}

  /**
   * Replaces the local copy of an item, and the local data it holds, by the one of the CDN.
   *
   * @param selection - The item, and the tables to restore for a database.
   * @returns What was done.
   */
  async pull(selection: EnvironmentSelection): Promise<TransferResult> {
    const { item, tables } = selection;
    if (!(await this.download(item.path))) {
      return { done: false, detail: "absent from the CDN" };
    }

    const localPath = localPathOf(item.path);
    if (item.kind === "file") {
      return { done: true, detail: localPath };
    }

    if (item.kind === "bucket") {
      const count = await restoreBucket(this.s3(), item.bucket, readArchive(localPath));
      return { done: true, detail: `${count} objects restored in ${item.bucket}` };
    }

    const engine = databaseEngine(item.engine);
    const records = readArchive(localPath);
    const first = await records.next();
    if (first.done || first.value.header.type !== "database" || first.value.header.engine !== item.engine) {
      throw new Error(`${item.path} is not a ${item.engine} archive`);
    }

    if (tables === null) {
      await engine.reset(item.container);
    } else {
      assertKnownTables(tables, await engine.listTables(item.container), item.container);
    }

    const restored: string[] = [];
    for await (const { header, body } of records) {
      if (header.type === "schema" && tables === null) {
        await engine.importSchema(item.container, body);
      } else if (header.type === "table" && typeof header.name === "string" && (tables === null || tables.includes(header.name))) {
        await engine.importTable(item.container, header.name, body, tables !== null);
        restored.push(header.name);
      }
    }
    if (tables !== null) {
      assertKnownTables(tables, restored, item.path);
    }
    await engine.finish(item.container);

    return { done: true, detail: tables === null ? `database restored (${restored.length} tables)` : `tables restored: ${restored.join(", ")}` };
  }

  /**
   * Sends the local copy of an item to the CDN, after dumping the local database or bucket it
   * holds. For some tables of a database, only their rows are replaced in the stored archive.
   *
   * @param selection - The item, and the tables to dump for a database.
   * @returns What was done.
   */
  async push(selection: EnvironmentSelection): Promise<TransferResult> {
    const { item, tables } = selection;
    const localPath = localPathOf(item.path);
    let detail = localPath;
    if (item.kind === "database") {
      detail = await this.writeLocal(localPath, (archive) => this.dumpDatabase(item, tables, archive));
    } else if (item.kind === "bucket") {
      detail = await this.writeLocal(localPath, async (archive) => `${await snapshotBucket(this.s3(), item.bucket, archive)} objects of ${item.bucket}`);
    } else if (!(await fs.stat(localPath).then((stat) => stat.isFile(), () => false))) {
      return { done: false, detail: `no local file ${localPath}` };
    }

    await this._client.upload(item.path, localPath, mediaTypeOf(item.path));
    return { done: true, detail };
  }

  /**
   * Writes an archive of a local database: its schema and the rows of every table, or the stored
   * archive with the rows of some tables replaced.
   *
   * @param item - The database item.
   * @param tables - The tables to dump, or null for the whole database.
   * @param archive - The archive being written.
   * @returns What was dumped.
   */
  private async dumpDatabase(item: Extract<EnvironmentItem, { kind: "database" }>, tables: string[] | null, archive: ArchiveWriter): Promise<string> {
    const engine = databaseEngine(item.engine);
    const localTables = await engine.listTables(item.container);
    if (tables === null) {
      await archive.add({ type: "database", engine: item.engine });
      await archive.add({ type: "schema" }, engine.dumpSchema(item.container));
      for (const table of localTables) {
        await archive.add({ type: "table", name: table }, engine.dumpTable(item.container, table));
      }
      return `database dumped (${localTables.length} tables)`;
    }

    assertKnownTables(tables, localTables, item.container);
    const basePath = `${localPathOf(item.path)}.base`;
    try {
      if (!(await this.download(item.path, basePath))) {
        throw new Error(`${item.path} is not on the CDN yet: push the whole database first`);
      }

      for await (const { header, body } of readArchive(basePath)) {
        if (header.type !== "table" || typeof header.name !== "string" || !tables.includes(header.name)) {
          await archive.add(header, body);
        }
      }
      for (const table of tables) {
        await archive.add({ type: "table", name: table }, engine.dumpTable(item.container, table));
      }
    } finally {
      await fs.rm(basePath, { force: true });
    }

    return `tables dumped: ${tables.join(", ")}`;
  }

  /**
   * Writes an archive to a local file, replaced only once the archive is complete.
   *
   * @param localPath - The local file.
   * @param fill - Writes the records of the archive.
   * @returns What `fill` reports.
   */
  private async writeLocal(localPath: string, fill: (archive: ArchiveWriter) => Promise<string>): Promise<string> {
    await fs.mkdir(path.dirname(localPath), { recursive: true, mode: 0o700 });
    const partialPath = `${localPath}.part`;
    const archive = new ArchiveWriter(partialPath);
    try {
      const detail = await fill(archive);
      await archive.close();
      await fs.rename(partialPath, localPath);
      return detail;
    } catch (error) {
      archive.abort();
      throw error;
    } finally {
      await fs.rm(partialPath, { force: true });
    }
  }

  /**
   * Downloads a file of the CDN to a local file, replaced only once the download is complete.
   *
   * @param filePath - The path of the file on the CDN.
   * @param localPath - The local file, its mirror in the environment directory by default.
   * @returns False when the CDN has no such file.
   */
  private async download(filePath: string, localPath = localPathOf(filePath)): Promise<boolean> {
    const content = await this._client.download(filePath);
    if (!content) {
      return false;
    }

    await fs.mkdir(path.dirname(localPath), { recursive: true, mode: 0o700 });
    const partialPath = `${localPath}.part`;
    try {
      await fs.writeFile(partialPath, content, { mode: 0o600 });
      await fs.rename(partialPath, localPath);
    } finally {
      await fs.rm(partialPath, { force: true });
    }
    return true;
  }

  /**
   * Gives the client of the local S3 server.
   *
   * @returns The client.
   */
  private s3(): S3Client {
    if (!this._options.s3) {
      throw new Error("the environment declares buckets without `s3` server");
    }

    this._s3 ??= createS3Client(this._options.s3);
    return this._s3;
  }
}
