import { loadMergedConfig, type RawConfig, resolveDefaultConfigPaths } from "@appsys/devtool-config";
import { logger } from "@appsys/devtool-shared";
import pkg from "../package.json" with { type: "json" };
import { DevtoolServer } from "./server.js";
import { mergeDeep, toRecord, toStringArray } from "./utils.js";
import type { ServerBootstrapOptions } from "./types.js";

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
    const defaultCommand = toRecord(commands.default);
    if (Array.isArray(defaultCommand.args)) {
      args = defaultCommand.args.filter((item): item is string => typeof item === "string");
      if ("env" in defaultCommand) {
        env = defaultCommand.env;
      }
    } else if (typeof defaultCommand.alias === "string") {
      const alias = toRecord(commands[defaultCommand.alias]);
      const aliasArgs = toStringArray(alias.args);
      if (aliasArgs?.length) {
        args = aliasArgs;
      }
      if ("env" in alias) {
        env = alias.env;
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

function createRuntimeConfig(raw: RawConfig, options: Pick<ServerBootstrapOptions, "serverPort" | "loadBalancerPort"> & { ssl: string | null; uiPath: string | null }): RawConfig {
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
    const { config, loadedPaths } = await loadMergedConfig(resolvedPaths);
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
