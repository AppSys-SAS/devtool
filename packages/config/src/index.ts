import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { glob } from "glob";
import yaml from "js-yaml";
import cloneDeep from "lodash.clonedeep";
import mergeWith from "lodash.mergewith";

export type RawConfig = Record<string, unknown>;

function resolveHomePath(input: string): string {
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
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

async function loadConfigFileInternal(filePath: string, seen: Set<string>): Promise<RawConfig> {
  const resolvedFilePath = path.resolve(filePath);
  if (seen.has(resolvedFilePath)) {
    return {};
  }

  seen.add(resolvedFilePath);

  const fileContent = await fs.readFile(resolvedFilePath, { encoding: "utf-8" });
  const loaded = yaml.load(fileContent);
  const config = (typeof loaded === "object" && loaded ? (loaded as RawConfig) : {}) as RawConfig;
  const cwd = path.dirname(resolvedFilePath);
  const includes = Array.isArray(config.include) ? (config.include as unknown[]).filter((item): item is string => typeof item === "string") : [];

  for (const include of includes) {
    const includeGlob = resolveHomePath(include);
    const files = (await glob(includeGlob, { cwd, absolute: true })).sort((a, b) => a.localeCompare(b));

    for (const includePath of files) {
      mergeConfig(config, await loadConfigFileInternal(includePath, seen));
    }
  }

  delete config.include;

  return config;
}

export async function loadConfigFile(filePath: string): Promise<RawConfig> {
  return loadConfigFileInternal(filePath, new Set<string>());
}

export function resolveDefaultConfigPaths(cwd = process.cwd()): string[] {
  return [path.join(cwd, "devtool-config.yml"), path.join(os.homedir(), ".config/appsys/devtool/config.yml")];
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
