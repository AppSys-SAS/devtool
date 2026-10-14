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

function resolveLoadBalancerCertificatePaths(config: RawConfig, cwd: string): void {
  if (typeof config.loadBalancers !== "object" || config.loadBalancers === null) {
    return;
  }

  for (const options of Object.values(config.loadBalancers)) {
    if (typeof options !== "object" || options === null) {
      continue;
    }

    const certificate = options as Record<string, unknown>;
    if (typeof certificate.crt === "string") {
      certificate.crt = resolveConfigPath(cwd, certificate.crt);
    }
    if (typeof certificate.key === "string") {
      certificate.key = resolveConfigPath(cwd, certificate.key);
    }
  }
}

function resolveAdtPaths(config: RawConfig, cwd: string): void {
  if (typeof config.adt !== "object" || config.adt === null) {
    return;
  }

  const adt = config.adt as Record<string, unknown>;
  if (typeof adt.uiPath === "string") {
    adt.uiPath = resolveConfigPath(cwd, adt.uiPath);
  }
}

function resolveSectionPaths(config: RawConfig, cwd: string): void {
  if (typeof config.sections !== "object" || config.sections === null) {
    return;
  }

  for (const sectionValue of Object.values(config.sections)) {
    if (typeof sectionValue !== "object" || sectionValue === null) {
      continue;
    }

    const section = sectionValue as Record<string, unknown>;
    if (typeof section.path === "string") {
      section.path = resolveConfigPath(cwd, section.path);
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

/**
 * Loads a YAML config file, expands environment variables, merges its includes recursively, and normalizes relative paths.
 * @param filePath Path of the YAML config file to load.
 * @param seen Set of already loaded absolute file paths used to prevent include cycles.
 * @returns The merged raw configuration object.
 */
async function loadConfigFileInternal(filePath: string, seen: Set<string>): Promise<RawConfig> {
  const resolvedFilePath = path.resolve(filePath);
  if (seen.has(resolvedFilePath)) {
    return {};
  }

  seen.add(resolvedFilePath);

  const fileContent = await fs.readFile(resolvedFilePath, { encoding: "utf-8" });

  return parseConfig(fileContent, path.dirname(resolvedFilePath), seen);
}

/**
 * Parses a YAML configuration, expands environment variables, merges its includes recursively, and normalizes relative paths.
 * @param content YAML text of the configuration.
 * @param cwd Directory relative paths and includes are resolved from.
 * @param seen Set of already loaded absolute file paths used to prevent include cycles.
 * @returns The merged raw configuration object.
 */
async function parseConfig(content: string, cwd: string, seen: Set<string>): Promise<RawConfig> {
  const loaded = load(content);
  const config = expandEnvVarsDeep(typeof loaded === "object" && loaded ? (loaded as RawConfig) : {}) as RawConfig;
  const includes = Array.isArray(config.include) ? (config.include as unknown[]).filter((item): item is string => typeof item === "string") : [];

  for (const include of includes) {
    const includeGlob = expandEnvVars(include);
    const files = (await glob(includeGlob, { cwd, absolute: true })).sort((a, b) => a.localeCompare(b));

    for (const includePath of files) {
      mergeConfig(config, await loadConfigFileInternal(includePath, seen));
    }
  }

  delete config.include;
  resolveAdtPaths(config, cwd);
  resolveSectionPaths(config, cwd);
  resolveLoadBalancerCertificatePaths(config, cwd);

  return config;
}

export async function loadConfigFile(filePath: string): Promise<RawConfig> {
  return loadConfigFileInternal(filePath, new Set<string>());
}

/**
 * Parses a YAML configuration that does not come from a file, as a file of a directory would be.
 * @param content YAML text of the configuration.
 * @param cwd Directory relative paths and includes are resolved from.
 * @returns The merged raw configuration object.
 */
export async function parseConfigText(content: string, cwd: string): Promise<RawConfig> {
  return parseConfig(content, cwd, new Set<string>());
}

export function resolveDefaultConfigPaths(cwd = process.cwd()): string[] {
  return [path.join(cwd, "../../devtool-config.yml"), path.join(os.homedir(), ".config/appsys/devtool/config.yml")];
}

export async function loadMergedConfig(configPaths = resolveDefaultConfigPaths()): Promise<{ config: RawConfig; loadedPaths: string[] }> {
  const loadedPaths: string[] = [];
  const result: RawConfig = {};

  for (const configPath of configPaths) {
    const absolutePath = path.resolve(resolveHomePath(configPath));
    if (!(await pathExists(absolutePath))) {
      continue;
    }

    mergeConfig(result, await loadConfigFile(absolutePath));
    loadedPaths.push(absolutePath);
  }

  return {
    config: result,
    loadedPaths,
  };
}
