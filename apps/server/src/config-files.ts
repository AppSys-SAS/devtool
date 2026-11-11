import fs from "node:fs/promises";
import { localPathOf, readEnvironmentOptions, readYamlMap, SHARED_CONFIG_PATH, writeLocalFile } from "@appsys/devtool-cdn";
import type { RawConfig } from "@appsys/devtool-config";
import type { ConfigFilePayload, ConfigFilesPayload } from "@appsys/devtool-shared";

const YAML_EXTENSION = /\.ya?ml$/;
const LOCAL_YAML_EXTENSION = /\.local\.ya?ml$/;

/**
 * Gives the personal override of a YAML configuration file, next to it and never synchronized.
 *
 * @param path - The path of the file, such as `account/config.yml`.
 * @returns The path of its override, such as `account/config.local.yml`, or null for a file that is not YAML or is an override itself.
 */
function localOverrideOf(path: string): string | null {
  return YAML_EXTENSION.test(path) && !LOCAL_YAML_EXTENSION.test(path) ? path.replace(YAML_EXTENSION, ".local.yml") : null;
}

/**
 * Lists the editable files: the files of the environment, sorted, each followed by its personal override.
 *
 * @param files - The paths of the files of the environment.
 * @returns The paths of the editable files.
 */
function editablePaths(files: string[]): string[] {
  const paths = [...files].sort().flatMap((path) => [path, localOverrideOf(path)]);
  return [...new Set(paths.filter((path) => path !== null))];
}

/**
 * Lists the files declared by an `environment` section of the configuration.
 *
 * @param section - The raw section.
 * @returns Their paths, the shared devtool configuration alone when the section is missing or invalid.
 */
function environmentFiles(section: unknown): string[] {
  try {
    return readEnvironmentOptions(section)?.items.filter((item) => item.kind === "file").map((item) => item.path) ?? [SHARED_CONFIG_PATH];
  } catch {
    return [SHARED_CONFIG_PATH];
  }
}

/**
 * Configuration files of the development environment the interface edits: the files of the
 * environment and the personal override of each YAML one, read and written in their local copies only.
 */
export class DevtoolConfigFiles {
  private _paths: string[] = editablePaths([SHARED_CONFIG_PATH]);

  /**
   * Takes the files declared by the `environment` section of the configuration.
   *
   * @param config - The raw configuration.
   */
  configure(config: RawConfig): void {
    this._paths = editablePaths(environmentFiles(config.environment));
  }

  /**
   * Lists the editable files.
   *
   * @returns Their paths.
   */
  list(): ConfigFilesPayload {
    return { paths: this._paths };
  }

  /**
   * Tells whether a file belongs to the devtool configuration.
   *
   * @param path - The path of the file.
   * @returns True for the shared or personal devtool configuration.
   */
  isDevtoolConfig(path: string): boolean {
    return path === SHARED_CONFIG_PATH || path === localOverrideOf(SHARED_CONFIG_PATH);
  }

  /**
   * Reads the local copy of a file.
   *
   * @param path - The path of the file.
   * @returns The file, with why it could not be read, if it could not.
   */
  async read(path: string): Promise<ConfigFilePayload> {
    const payload: ConfigFilePayload = { path, content: null, updatedAt: null, saved: false, conflict: false, error: null };
    if (!this._paths.includes(path)) {
      return { ...payload, error: `${path} is not an editable configuration file` };
    }

    try {
      const localPath = localPathOf(path);
      const [content, stat] = await Promise.all([fs.readFile(localPath, "utf-8"), fs.stat(localPath)]);
      return { ...payload, content, updatedAt: stat.mtime.toISOString() };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? payload : { ...payload, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Replaces the local copy of a file, unless it changed since it was read or its YAML is invalid.
   *
   * @param path - The path of the file.
   * @param content - The new content.
   * @param baseUpdatedAt - Last change of the copy the content was edited from, null when there was none.
   * @returns The local copy as it now stands, with whether it was replaced and why not.
   */
  async write(path: string, content: string, baseUpdatedAt: string | null): Promise<ConfigFilePayload> {
    const current = await this.read(path);
    if (current.error) {
      return current;
    }

    if (current.updatedAt !== baseUpdatedAt) {
      return { ...current, conflict: true, error: `${path} changed on disk since it was opened` };
    }

    if (YAML_EXTENSION.test(path)) {
      try {
        readYamlMap(content, path);
      } catch (error) {
        return { ...current, error: error instanceof Error ? error.message : String(error) };
      }
    }

    try {
      await writeLocalFile(localPathOf(path), content);
    } catch (error) {
      return { ...current, error: error instanceof Error ? error.message : String(error) };
    }

    return { ...(await this.read(path)), saved: true };
  }
}
