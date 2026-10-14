import path from "node:path";
import { CdnClient, readCdnOptions, REMOTE_CONFIG_PATH } from "@appsys/devtool-cdn";
import { loadMergedConfig, mergeConfig, parseConfigText, type RawConfig, resolveDefaultConfigPaths } from "@appsys/devtool-config";
import { logger } from "@appsys/devtool-shared";
import pkg from "../package.json" with { type: "json" };
import { DevtoolServer } from "./server.js";
import { mergeDeep, toCommandArgsArray, toRecord, toStringArray } from "./utils.js";
import type { ServerBootstrapOptions } from "./types.js";

function readKillSignal(record: Record<string, unknown>): unknown {
  return record.killSignal ?? record.killsignal;
}

function readShell(record: Record<string, unknown>): unknown {
  return record.shell;
}

function normalizeProjectsShape(config: RawConfig): RawConfig {
  const sections = toRecord(config.sections);
  const projects = toRecord(config.projects);
  const firstProject = Object.keys(projects).length ? toRecord(projects[Object.keys(projects)[0]]) : null;

  if (!Object.keys(sections).length || !Object.keys(projects).length) {
    return config;
  }

  if (firstProject && typeof firstProject.directories === "object") {
    return config;
  }

  if (!toRecord(sections.uncategorized).name) {
    sections.uncategorized = { name: "Uncategorized", path: "." };
  }

  for (const [projectSlug, rawProject] of Object.entries(projects)) {
    const project = toRecord(rawProject);
    const sectionSlug = typeof project.section === "string" ? project.section : "uncategorized";
    const section = toRecord(sections[sectionSlug]);
    const sectionProjects = Array.isArray(section.projects) ? section.projects.filter((item): item is string => typeof item === "string") : [];
    const sectionDirectories = toRecord(section.directories);
    const commands = toRecord(project.commands);
    const services = toRecord(project.services);

    if (typeof section.path !== "string") {
      section.path = ".";
    }

    let args = ["pnpm", "run", "start"];
    let env: unknown = project.env;
    let shell: unknown = readShell(project);
    let killSignal: unknown = readKillSignal(project);
    const defaultCommand = toRecord(commands.default);
    if (Array.isArray(defaultCommand.args)) {
      const defaultArgs = toCommandArgsArray(defaultCommand.args);
      if (defaultArgs) {
        args = defaultArgs;
      }
      if ("env" in defaultCommand) {
        env = defaultCommand.env;
      }
      if ("shell" in defaultCommand) {
        shell = readShell(defaultCommand);
      }
      if ("killSignal" in defaultCommand || "killsignal" in defaultCommand) {
        killSignal = readKillSignal(defaultCommand);
      }
    } else if (typeof defaultCommand.alias === "string") {
      const alias = toRecord(commands[defaultCommand.alias]);
      const aliasArgs = toCommandArgsArray(alias.args);
      if (aliasArgs) {
        args = aliasArgs;
      }
      if ("env" in alias) {
        env = alias.env;
      }
      if ("shell" in alias) {
        shell = readShell(alias);
      }
      if ("killSignal" in alias || "killsignal" in alias) {
        killSignal = readKillSignal(alias);
      }
    }

    const extras: Record<string, unknown> = {};
    for (const [commandSlug, command] of Object.entries(commands)) {
      if (commandSlug === "default") {
        continue;
      }
      extras[commandSlug] = command;
    }

    sectionProjects.push(projectSlug);
    sectionDirectories[projectSlug] = {
      ...project,
      args,
      env,
      shell,
      killSignal,
      extras,
      loadBalancer: services,
    };

    section.projects = sectionProjects;
    section.directories = sectionDirectories;
    sections[sectionSlug] = section;
  }

  const normalizedSections: Record<string, unknown> = {};
  for (const [sectionSlug, sectionRaw] of Object.entries(sections)) {
    const section = toRecord(sectionRaw);
    const sectionDirectories = toRecord(section.directories);
    if (!Object.keys(sectionDirectories).length) {
      continue;
    }
    normalizedSections[sectionSlug] = section;
  }

  config.projects = normalizedSections;
  return config;
}

export function createRuntimeConfig(raw: RawConfig, options: Pick<ServerBootstrapOptions, "serverPort" | "loadBalancerPort"> & { ssl: string | null; uiPath: string | null }): RawConfig {
  const adtRuntimeOverrides: Record<string, unknown> = {
  };

  if (typeof options.uiPath === "string" && options.uiPath.length > 0) {
    adtRuntimeOverrides.uiPath = options.uiPath;
  }

  const portOverrides: Record<string, number> = {};
  if (Number.isInteger(options.serverPort) && (options.serverPort as number) > 0) {
    portOverrides.server = options.serverPort as number;
  }
  if (Number.isInteger(options.loadBalancerPort) && (options.loadBalancerPort as number) > 0) {
    portOverrides.loadBalancer = options.loadBalancerPort as number;
  }
  if (Object.keys(portOverrides).length > 0) {
    adtRuntimeOverrides.ports = portOverrides;
  }

  if (typeof options.ssl === "string" && options.ssl.length > 0) {
    adtRuntimeOverrides.host = options.ssl;
    adtRuntimeOverrides.secure = true;
  }

  const base = mergeDeep(
    {
      loadBalancers: {},
      adt: {
        notifications: true,
      },
    },
    raw,
    {
      adt: adtRuntimeOverrides,
    },
  ) as RawConfig;

  const serverConfig = toRecord(base.server);
  const serverHosts = toStringArray(serverConfig.hosts);
  const adtConfig = toRecord(base.adt);
  adtConfig.hosts = serverHosts ?? [];
  base.adt = adtConfig;

  const serverDomains = toRecord(serverConfig.domains);
  const loadBalancers = toRecord(base.loadBalancers);
  for (const [domain, optionsValue] of Object.entries(serverDomains)) {
    const domainConfig = toRecord(optionsValue);
    if (typeof domainConfig.certificate === "string" && typeof domainConfig.key === "string") {
      loadBalancers[domain] = {
        crt: domainConfig.certificate,
        key: domainConfig.key,
      };
    }
  }
  base.loadBalancers = loadBalancers;

  return normalizeProjectsShape(base);
}

/**
 * Loads the devtool configuration stored on the CDN named by the local configuration.
 * @param local Local configuration, holding the `cdn` section.
 * @param cwd Directory relative paths of the stored configuration are resolved from.
 * @returns The stored configuration with its address, or null when there is none or it cannot be loaded.
 */
async function loadRemoteConfig(local: RawConfig, cwd: string): Promise<{ config: RawConfig; source: string } | null> {
  const options = readCdnOptions(local.cdn);
  if (!options) {
    return null;
  }

  const source = `${options.url}/devtool/${REMOTE_CONFIG_PATH}`;
  try {
    const text = await new CdnClient(options).readText(REMOTE_CONFIG_PATH);
    if (text === null) {
      logger.warn("Server", "Config", `No configuration stored at ${source}`);
      return null;
    }

    return { config: await parseConfigText(text, cwd), source };
  } catch (error) {
    logger.warn("Server", "Config", `Configuration of ${source} not loaded, local files only: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Loads the configuration: the first file, overridden by the configuration stored on the CDN, overridden by the other files.
 * @param paths Paths of the configuration files, the shared one first.
 * @returns The merged configuration and the sources it was loaded from.
 */
async function loadConfiguration(paths: string[]): Promise<{ config: RawConfig; loadedPaths: string[] }> {
  const base = await loadMergedConfig(paths.slice(0, 1));
  const overrides = await loadMergedConfig(paths.slice(1));
  const local = mergeConfig(mergeConfig({}, base.config), overrides.config);
  const remote = await loadRemoteConfig(local, paths.length ? path.dirname(path.resolve(paths[0])) : process.cwd());

  return {
    config: mergeConfig(mergeConfig(base.config, remote?.config ?? {}), overrides.config),
    loadedPaths: [...base.loadedPaths, ...(remote ? [remote.source] : []), ...overrides.loadedPaths],
  };
}

/**
 * Starts the devtool server, reloading its configuration on every reconfiguration.
 * @param options Ports, SSL domain, UI path and configuration files of the server.
 * @returns The running server.
 */
export default async function runServer({
  serverPort,
  loadBalancerPort,
  ssl = null,
  uiPath = null,
  configPaths,
}: ServerBootstrapOptions = {}): Promise<DevtoolServer> {
  const resolvedPaths = configPaths?.length ? configPaths : resolveDefaultConfigPaths();

  logger.info("Server", "Startup", `Config paths: ${resolvedPaths.join(", ")}`);

  return DevtoolServer.run(async () => {
    const { config, loadedPaths } = await loadConfiguration(resolvedPaths);
    return {
      raw: createRuntimeConfig(config, {
        serverPort,
        loadBalancerPort,
        ssl,
        uiPath,
      }),
      loadedPaths,
    };
  }, pkg.version);
}
