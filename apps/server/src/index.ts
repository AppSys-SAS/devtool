import { execFile, spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { loadMergedConfig, type RawConfig, resolveDefaultConfigPaths } from "@appsys/devtool-config";
import { logger, type RuntimeConfig } from "@appsys/devtool-shared";
import pkg from "../package.json" with { type: "json" };
import { prepareRenewal } from "./certificates.js";
import { CommandSecrets } from "./command-automation.js";
import { certificateAutomationKey, DevtoolConfigure } from "./configure.js";
import { DevtoolLB } from "./lb.js";
import { DevtoolServer } from "./server.js";
import { mergeDeep, toRecord, toStringArray } from "./utils.js";
import type { ConfigProvider, LoadBalancerContext, ServerBootstrapOptions } from "./types.js";

export { relaunchUnderApp } from "./app-launcher.js";

const CONFIG_CHANGE_DELAY_MS = 200;
const execFileAsync = promisify(execFile);

function readKillSignal(record: Record<string, unknown>): unknown {
  return record.killSignal ?? record.killsignal;
}

function readShell(record: Record<string, unknown>): unknown {
  return record.shell;
}

/**
 * Turns the sections and projects of the shared configuration into projects of directories, each
 * project becoming a directory of its section with its commands, the one its default action names
 * becoming its main command.
 * @param config The raw configuration.
 * @returns The configuration with projects of directories.
 */
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

    let args: unknown = null;
    let env: unknown = project.env;
    let shell: unknown = readShell(project);
    let killSignal: unknown = readKillSignal(project);
    const action = toRecord(project.default).action;
    const defaultCommandSlug = typeof action === "string" && action.startsWith("command:") ? action.slice("command:".length) : null;
    if (defaultCommandSlug && defaultCommandSlug in commands) {
      const defaultCommand = toRecord(commands[defaultCommandSlug]);
      args = defaultCommand.args;
      if ("env" in defaultCommand) {
        env = defaultCommand.env;
      }
      if ("shell" in defaultCommand) {
        shell = readShell(defaultCommand);
      }
      if ("killSignal" in defaultCommand || "killsignal" in defaultCommand) {
        killSignal = readKillSignal(defaultCommand);
      }
    }

    sectionProjects.push(projectSlug);
    sectionDirectories[projectSlug] = {
      ...project,
      args,
      env,
      shell,
      killSignal,
      extras: commands,
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

/**
 * Applies the startup options to the configuration: ports, SSL domain and the interface, which only
 * comes from the startup options, never from the configuration files.
 * @param raw The merged configuration files.
 * @param options The startup options.
 * @returns The configuration the server runs with.
 */
export function createRuntimeConfig(raw: RawConfig, options: Pick<ServerBootstrapOptions, "serverPort" | "loadBalancerPort"> & { ssl: string | null; uiPath: string | null }): RawConfig {
  const adtRuntimeOverrides: Record<string, unknown> = {};

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
  delete adtConfig.uiPath;
  if (options.uiPath) {
    adtConfig.uiPath = options.uiPath;
  }
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
 * Resolves the configuration files to load, the defaults when none are given.
 * @param configPaths Paths of the configuration files.
 * @returns The paths of the configuration files.
 */
function resolveConfigPaths(configPaths: string[] | undefined): string[] {
  const resolvedPaths = configPaths?.length ? configPaths : resolveDefaultConfigPaths();
  logger.info("Server", "Startup", `Config paths: ${resolvedPaths.join(", ")}`);
  return resolvedPaths;
}

/**
 * Creates the loader of the merged configuration files, with the runtime overrides applied.
 * @param options Ports, SSL domain and UI path overriding the configuration files.
 * @param configPaths Paths of the configuration files.
 * @returns The configuration loader.
 */
function createConfigProvider({ serverPort, loadBalancerPort, ssl, uiPath }: ServerBootstrapOptions, configPaths: string[]): ConfigProvider {
  return async () => {
    const { config, loadedPaths } = await loadMergedConfig(configPaths);
    return {
      raw: createRuntimeConfig(config, {
        serverPort,
        loadBalancerPort,
        ssl: ssl ?? null,
        uiPath: uiPath ?? null,
      }),
      loadedPaths,
    };
  };
}

/**
 * Loads the configuration and validates it into the runtime configuration.
 * @param configProvider Loads the configuration.
 * @returns The runtime configuration.
 */
async function loadRuntimeConfig(configProvider: ConfigProvider): Promise<RuntimeConfig> {
  const configure = new DevtoolConfigure((await configProvider()).raw);
  await configure.reconfigure();
  return configure.runtimeConfig;
}

/**
 * Calls a listener shortly after any of some files changes, including when it is replaced.
 * @param configPaths Paths of the files.
 * @param onChange Called once per burst of changes.
 */
function watchConfigFiles(configPaths: string[], onChange: () => void): void {
  let changeTimer: ReturnType<typeof setTimeout> | null = null;
  const absolutePaths = configPaths.map((configPath) => path.resolve(configPath));

  for (const directory of new Set(absolutePaths.map((configPath) => path.dirname(configPath)))) {
    if (!existsSync(directory)) {
      continue;
    }

    watch(directory, (_event, changed) => {
      if (!changed || !absolutePaths.includes(path.join(directory, changed))) {
        return;
      }

      if (changeTimer) {
        clearTimeout(changeTimer);
      }
      changeTimer = setTimeout(onChange, CONFIG_CHANGE_DELAY_MS);
    });
  }
}

/**
 * Starts the devtool server, reloading its configuration on every reconfiguration.
 * @param options Ports, SSL domain, UI path, configuration files of the server and whether it runs the load balancer.
 * @returns The running server.
 */
export default async function runServer(options: ServerBootstrapOptions = {}): Promise<DevtoolServer> {
  const configPaths = resolveConfigPaths(options.configPaths);
  return DevtoolServer.run(createConfigProvider(options, configPaths), pkg.version, options.loadBalancer ?? true);
}

/**
 * Renews certificates of the configuration now, their output in this terminal, each written where it is
 * served once its renewal succeeded.
 * @param names Names of the certificates in the configuration, every renewed one when empty.
 * @param configPaths Configuration files, the default ones when empty.
 * @throws When a certificate is unknown or its renewal fails.
 */
export async function renewCertificates(names: string[], configPaths: string[] = []): Promise<void> {
  const configure = new DevtoolConfigure((await createConfigProvider({}, resolveConfigPaths(configPaths))()).raw);
  await configure.reconfigure();
  const certificates = Object.fromEntries(
    Object.entries(configure.runtimeConfig.loadBalancers)
      .map(([domain, certificate]) => [domain.replace(/^\./, ""), certificate] as const)
      .filter(([, certificate]) => certificate.acme),
  );
  const unknown = names.filter((name) => !certificates[name]);
  if (unknown.length) {
    throw new Error(`no renewed certificate named ${unknown.join(", ")} (renewed: ${Object.keys(certificates).join(", ") || "none"})`);
  }

  for (const name of names.length ? names : Object.keys(certificates)) {
    const certificate = certificates[name];
    const renewal = await prepareRenewal(name, certificate, configure.runtimeConfig.adt.cacheDir, true, (line) => logger.info("Certificates", name, line));
    const automation = configure.automations[certificateAutomationKey(name)];
    const secrets = new CommandSecrets(automation?.opAccount ?? null, async (command) => (await execFileAsync("/bin/sh", ["-c", command])).stdout.replace(/\n+$/, ""));
    try {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(certificate.acme?.env ?? {})) {
        env[key] = await secrets.resolve(value);
      }
      const args: string[] = [];
      for (const arg of renewal.args) {
        args.push(await secrets.resolve(arg));
      }
      logger.info("Certificates", name, `Renewing in ${renewal.cwd}`);
      const exitCode = await new Promise<number>((resolve, reject) => {
        spawn(args[0], args.slice(1), { cwd: renewal.cwd, env: { ...process.env, ...env }, stdio: "inherit" })
          .on("error", reject)
          .on("exit", (code) => resolve(code ?? 1));
      });
      if (exitCode !== 0) {
        throw new Error(`renewal of ${name} exited with code ${exitCode}`);
      }
      await renewal.finish();
      logger.info("Certificates", name, `Renewed: ${certificate.crt}`);
    } finally {
      secrets.close();
    }
  }
}

/**
 * Starts the load balancer on its own, reloading its configuration whenever a configuration file, or a
 * certificate or key file it serves, changes.
 * @param options Ports, SSL domain, UI path and configuration files of the load balancer.
 * @returns The running load balancer.
 */
export async function runLoadBalancer(options: ServerBootstrapOptions = {}): Promise<DevtoolLB> {
  const configPaths = resolveConfigPaths(options.configPaths);
  const configProvider = createConfigProvider(options, configPaths);
  const context: LoadBalancerContext = { config: await loadRuntimeConfig(configProvider) };
  const lb = await DevtoolLB.create(context);
  await lb.listen();

  const certificateFiles = Object.values(context.config.loadBalancers)
    .flatMap((certificate) => [certificate.crt, certificate.key])
    .filter((file) => !file.trimStart().startsWith("-----BEGIN "));
  watchConfigFiles([...configPaths, ...certificateFiles], () => {
    void (async () => {
      context.config = await loadRuntimeConfig(configProvider);
      if (await lb.reload(context.config)) {
        await lb.recreate();
      }
      logger.info("LoadBalancer", "Config", "Reloaded");
    })().catch((error: unknown) => {
      logger.warn("LoadBalancer", "Config", `Not reloaded: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  return lb;
}
