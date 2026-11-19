import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { glob } from "glob";
import { load } from "js-yaml";
import cloneDeep from "lodash.clonedeep";
import mergeWith from "lodash.mergewith";

export type RawConfig = Record<string, unknown>;

const ENV_VAR_PATTERN = /\$(\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

function resolveHomePath(input: string): string {
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

function expandEnvVars(input: string): string {
  const withHome = resolveHomePath(input);

  return withHome.replace(ENV_VAR_PATTERN, (_, _full, bracedName: string | undefined, plainName: string | undefined) => {
    const varName = bracedName ?? plainName;
    if (!varName) {
      return _;
    }

    const value = process.env[varName];
    return typeof value === "string" ? value : _;
  });
}

function expandEnvVarsDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return expandEnvVars(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => expandEnvVarsDeep(item));
  }

  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = expandEnvVarsDeep(item);
    }
    return output;
  }

  return value;
}

function resolveConfigPath(cwd: string, input: string): string {
  if (path.isAbsolute(input) || input.trimStart().startsWith("-----BEGIN ")) {
    return input;
  }

  return path.resolve(cwd, input);
}

/**
 * Resolves a path setting of a record from a directory, leaving other values untouched.
 * @param record The record holding the setting.
 * @param key The name of the setting.
 * @param cwd Directory the relative path is resolved from.
 */
function resolvePathSetting(record: unknown, key: string, cwd: string): void {
  if (typeof record === "object" && record !== null) {
    const settings = record as Record<string, unknown>;
    if (typeof settings[key] === "string") {
      settings[key] = resolveConfigPath(cwd, settings[key]);
    }
  }
}

/**
 * Resolves the paths a configuration file gives relative to the configuration folder: the cache, the icon, the
 * certificates of the load balancers, the environment folder and the workspace.
 * @param config The configuration of the file.
 * @param cwd The configuration folder.
 */
function resolveFolderPaths(config: RawConfig, cwd: string): void {
  resolvePathSetting(config, "workspace", cwd);
  resolvePathSetting(config.adt, "cacheDir", cwd);
  resolvePathSetting(config.adt, "icon", cwd);
  resolvePathSetting(config.environment, "folder", cwd);
  if (typeof config.loadBalancers === "object" && config.loadBalancers !== null) {
    for (const certificate of Object.values(config.loadBalancers)) {
      resolvePathSetting(certificate, "crt", cwd);
      resolvePathSetting(certificate, "key", cwd);
    }
  }
}

/**
 * Gives the sections declaring no path the `sectionPath` of the configuration, the workspace itself by
 * default, then resolves the paths of the sections from the workspace, leaving them relative without one.
 * @param config The merged configuration.
 * @param workspace The workspace, null when none is declared.
 */
function resolveSectionPaths(config: RawConfig, workspace: string | null): void {
  if (typeof config.sections !== "object" || config.sections === null) {
    return;
  }

  const fallback = typeof config.sectionPath === "string" ? config.sectionPath : ".";
  for (const sectionValue of Object.values(config.sections)) {
    if (typeof sectionValue !== "object" || sectionValue === null) {
      continue;
    }

    const section = sectionValue as Record<string, unknown>;
    if (typeof section.path !== "string") {
      section.path = fallback;
    }
    if (workspace !== null) {
      section.path = resolveConfigPath(workspace, section.path as string);
    }
  }
}

async function pathExists(fullPath: string): Promise<boolean> {
  try {
    await fs.stat(fullPath);
    return true;
  } catch {
    return false;
  }
}

export function mergeConfig<T extends RawConfig>(a: T, b: RawConfig): T {
  return mergeWith(a, cloneDeep(b), (left: unknown, right: unknown, key: string) => {
    if (Array.isArray(left) && Array.isArray(right) && key === "include") {
      return left.concat(right);
    }

    return undefined;
  }) as T;
}

/** The files declaring each setting of a configuration, by {@link configSourceKey}, in the order they are merged. */
export type ConfigSources = Record<string, string[]>;

/**
 * Names a setting of a configuration among its sources.
 * @param settingPath The keys leading to the setting, list indexes included.
 * @returns The key of the setting.
 */
export function configSourceKey(settingPath: (string | number)[]): string {
  return JSON.stringify(settingPath.map(String));
}

/**
 * Records a file as declaring every setting it holds.
 * @param value The content of the file, or of one of its settings.
 * @param file The file.
 * @param sources The sources receiving the file.
 * @param prefix The keys leading to the value.
 */
function recordSources(value: unknown, file: string, sources: ConfigSources, prefix: string[] = []): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const settingPath = [...prefix, key];
    (sources[configSourceKey(settingPath)] ??= []).push(file);
    recordSources(child, file, sources, settingPath);
  }
}

/**
 * Loads a YAML config file, expands environment variables, merges its includes recursively, and normalizes relative paths.
 * @param filePath Path of the YAML config file to load.
 * @param seen Set of already loaded absolute file paths used to prevent include cycles.
 * @param baseDirectory Directory relative paths are resolved from; includes are resolved from the file directory.
 * @param sources Receives the file declaring each setting, the file before its includes.
 * @returns The merged raw configuration object.
 */
async function loadConfigFileInternal(filePath: string, seen: Set<string>, baseDirectory: string, sources: ConfigSources): Promise<RawConfig> {
  const resolvedFilePath = path.resolve(filePath);
  if (seen.has(resolvedFilePath)) {
    return {};
  }

  seen.add(resolvedFilePath);

  const fileContent = await fs.readFile(resolvedFilePath, { encoding: "utf-8" });
  const loaded = load(fileContent);
  const config = expandEnvVarsDeep(typeof loaded === "object" && loaded ? (loaded as RawConfig) : {}) as RawConfig;
  const cwd = path.dirname(resolvedFilePath);
  const includes = Array.isArray(config.include) ? (config.include as unknown[]).filter((item): item is string => typeof item === "string") : [];
  recordSources({ ...config, include: undefined }, resolvedFilePath, sources);

  for (const include of includes) {
    const includeGlob = expandEnvVars(include);
    const files = (await glob(includeGlob, { cwd, absolute: true })).sort((a, b) => a.localeCompare(b));

    for (const includePath of files) {
      mergeConfig(config, await loadConfigFileInternal(includePath, seen, baseDirectory, sources));
    }
  }

  delete config.include;
  resolveFolderPaths(config, baseDirectory);

  return config;
}

/**
 * Loads a YAML config file and its includes.
 * @param filePath Path of the YAML config file to load.
 * @param baseDirectory Directory relative paths are resolved from, the file directory by default.
 * @param sources Receives the file declaring each setting.
 * @returns The merged raw configuration object.
 */
export async function loadConfigFile(filePath: string, baseDirectory = path.dirname(path.resolve(filePath)), sources: ConfigSources = {}): Promise<RawConfig> {
  return loadConfigFileInternal(filePath, new Set<string>(), baseDirectory, sources);
}

/** The environment variable naming the configuration folder. */
export const CONFIG_FOLDER_VARIABLE = "ADT_CONFIG_FOLDER";

/**
 * Gives the configuration folder: the one named by `ADT_CONFIG_FOLDER`, else `~/.config/appsys/devtool`.
 * @returns The absolute path of the folder.
 */
export function resolveConfigFolder(): string {
  const folder = process.env[CONFIG_FOLDER_VARIABLE]?.trim();
  return path.resolve(resolveHomePath(folder || "~/.config/appsys/devtool"));
}

/**
 * Gives the `adt` settings of a configuration.
 * @param config The merged configuration.
 * @returns Its settings, empty when it has none.
 */
function adtOf(config: RawConfig): Record<string, unknown> {
  return typeof config.adt === "object" && config.adt !== null ? (config.adt as Record<string, unknown>) : {};
}

/**
 * Gives the cache folder of a configuration: its `adt.cacheDir`, else `~/.cache/appsys/devtool`.
 * @param config The merged configuration.
 * @returns The absolute path of the folder.
 */
export function resolveCacheFolder(config: RawConfig): string {
  const adt = adtOf(config);
  return typeof adt.cacheDir === "string" && adt.cacheDir.trim() ? adt.cacheDir : path.join(os.homedir(), ".cache/appsys/devtool");
}

/** How the devtool names and shows itself. */
export interface AppIdentity {
  /** The identifier, such as the name of its MCP server. */
  name: string;
  /** The name shown to people, such as the name of its app. */
  displayName: string;
  /** The image of its icon, null for the default one. */
  icon: string | null;
}

/** A setting of the identity left at its default, and why. */
export interface AppIdentityProblem {
  setting: string;
  message: string;
}

const DEFAULT_DISPLAY_NAME = "AppSys Devtool";
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const ICON_EXTENSIONS = [".svg", ".png", ".jpg", ".jpeg", ".icns"];

/**
 * Turns a display name into an identifier: lowercase, without accents, words joined by hyphens.
 * @param displayName The display name.
 * @returns The identifier, empty when the name holds no letter nor digit.
 */
function slugOf(displayName: string): string {
  return displayName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Gives how a configuration names and shows the devtool: `adt.displayName`, `adt.name` (by default the
 * identifier of the display name) and `adt.icon`, an invalid setting keeping its default.
 * @param config The merged configuration.
 * @returns The identity and the settings left at their default.
 */
export function resolveAppIdentity(config: RawConfig): { identity: AppIdentity; problems: AppIdentityProblem[] } {
  const adt = adtOf(config);
  const problems: AppIdentityProblem[] = [];

  let displayName = DEFAULT_DISPLAY_NAME;
  if (typeof adt.displayName === "string" && adt.displayName.trim() && !adt.displayName.includes("/")) {
    displayName = adt.displayName.trim();
  } else if (adt.displayName !== undefined) {
    problems.push({ setting: "adt.displayName", message: "must be a text without /" });
  }

  let name = slugOf(displayName) || slugOf(DEFAULT_DISPLAY_NAME);
  if (typeof adt.name === "string" && NAME_PATTERN.test(adt.name)) {
    name = adt.name;
  } else if (adt.name !== undefined) {
    problems.push({ setting: "adt.name", message: "must hold lowercase letters, digits, - and _ only" });
  }

  let icon: string | null = null;
  if (typeof adt.icon === "string" && ICON_EXTENSIONS.includes(path.extname(adt.icon).toLowerCase())) {
    icon = adt.icon;
  } else if (adt.icon !== undefined) {
    problems.push({ setting: "adt.icon", message: `must be a ${ICON_EXTENSIONS.join(", ")} file` });
  }

  return { identity: { name, displayName, icon }, problems };
}

/**
 * Lists the default configuration files: the shared configuration of the configuration folder, then the personal
 * overrides.
 * @param folder The configuration folder.
 * @returns The configuration paths, in merge order.
 */
export function resolveDefaultConfigPaths(folder = resolveConfigFolder()): string[] {
  return [path.join(folder, "config.yml"), path.join(folder, "config.local.yml")];
}

/**
 * Loads and merges configuration files, each overriding the previous ones. Relative paths are resolved from the
 * directory of the first file, the configuration folder, but those of the sections, `sectionPath` for the sections
 * declaring none, resolved from the `workspace` of the merged configuration and left relative without one.
 * @param configPaths Paths of the configuration files; missing files are skipped.
 * @returns The merged configuration, the files loaded, the files declaring each setting, and the personal override
 * among the paths (`*.local.yml`, loaded last), null when none is given.
 */
export async function loadMergedConfig(configPaths = resolveDefaultConfigPaths()): Promise<{ config: RawConfig; loadedPaths: string[]; sources: ConfigSources; localPath: string | null }> {
  const loadedPaths: string[] = [];
  const sources: ConfigSources = {};
  const result: RawConfig = {};
  const baseDirectory = configPaths.length ? path.dirname(path.resolve(resolveHomePath(configPaths[0]))) : process.cwd();
  const absolutePaths = configPaths.map((configPath) => path.resolve(resolveHomePath(configPath)));

  for (const absolutePath of absolutePaths) {
    if (!(await pathExists(absolutePath))) {
      continue;
    }

    mergeConfig(result, await loadConfigFile(absolutePath, baseDirectory, sources));
    loadedPaths.push(absolutePath);
  }
  resolveSectionPaths(result, typeof result.workspace === "string" ? result.workspace : null);

  return {
    config: result,
    loadedPaths,
    sources,
    localPath: absolutePaths.filter((configPath) => configPath.endsWith(".local.yml")).at(-1) ?? null,
  };
}
