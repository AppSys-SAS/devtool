import path from "node:path";
import fs from "node:fs/promises";
import net from "node:net";
import type { CertificateAcme, ClientConfigPayload, CommandArg, CommandChoice, CommandForm, CommandInput, CommandInputValue, DirectoryDefinition, DirectoryFiles, DirectoryScripts, ScriptSettings, AdtDefinition, DirectoryDefaultAction, DirectoryShortcut, DnsDefinition, DnsRecord, HostAccess, IntegrationDefinition, LoadBalancerCertificate, McpCategory, McpPatterns, McpRules, McpSettings, McpTarget, PassthroughRule, ProjectDefinition, ProjectRestore, RuntimeConfig, SidebarSettings } from "@appsys/devtool-shared";
import { defaultMcpRules, isMcpLevel, logger, readMcpRules } from "@appsys/devtool-shared";
import { type LegoOptionValue, legoRunArgs } from "@appsys/devtool-certs";
import { configSourceKey, resolveCacheFolder } from "@appsys/devtool-config";
import { type CommandAnswer, type CommandAutomation, findInvalidValueBlocks } from "./command-automation.js";
import { listScripts } from "./scripts.js";
import type { ConfigOrigin } from "./types.js";
import { isObject, toCommandArgsArray, toRecord, toStringArray, toStringRecord } from "./utils.js";

const SLUG_REGEXP = /^[a-zA-Z0-9\-\/_.]+$/i;
/** Options of `lego run` the devtool sets itself. */
const LEGO_OWNED_OPTIONS = ["path", "cert.name", "accept-tos", "renew-force", "renew-days", "no-random-sleep"];

/**
 * Names the automation of the renewal of a certificate among the automations of the configuration.
 * @param name The name of the certificate in the configuration.
 * @returns The key of its automation.
 */
export function certificateAutomationKey(name: string): string {
  return `loadBalancers/${name}/acme`;
}
const HOST_PATTERN_REGEXP = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const DEFAULT_INTEGRATION_ICON = "lucide:app-window";

/**
 * Gives the settings of the devtool before the configuration is read.
 * @returns The default settings.
 */
function defaultAdt(): AdtDefinition {
  return {
    host: null,
    cacheDir: resolveCacheFolder({}),
    shell: null,
    ports: {
      server: 6730,
      loadBalancer: 6731,
    },
    secure: false,
    notifications: true,
    hosts: [],
    access: "local",
    sidebar: { environment: false, configs: false, login: false },
    mcp: defaultMcpSettings(true),
  };
}

/**
 * Gives the MCP server settings before the configuration is read: off, unknown agents asked for, the
 * command lines outside the configuration refused.
 * @param notifications Whether the interfaces notify the requests of agents.
 * @returns The default settings.
 */
function defaultMcpSettings(notifications: boolean): McpSettings {
  const rules = defaultMcpRules("default");
  return {
    enabled: false,
    notifications,
    timeout: 120,
    default: rules,
    commands: rules,
    scripts: rules,
    files: rules,
    terminals: rules,
    certificates: rules,
    devtool: rules,
    clients: { level: "ask", allow: [], deny: [] },
    ownTerminals: "allow",
    shell: { level: "deny", allow: [], deny: [] },
    environment: rules,
  };
}

/** The categories of `adt.mcp` refining `adt.mcp.default`. */
const MCP_CATEGORIES: readonly McpCategory[] = ["commands", "scripts", "files", "terminals", "certificates", "devtool"];

/** An `mcp` setting declared by something holding others, applied over the rules of what it holds. */
interface McpLayer {
  value: unknown;
  from: string;
}
const SIGNAL_REGEXP = /^SIG[A-Z0-9]+$/;

export class DevtoolConfigure {
  private readonly initialConfig: Record<string, unknown>;

  public adt: AdtDefinition;

  public loadBalancers: Record<string, LoadBalancerCertificate>;

  public projects: Record<string, ProjectDefinition>;

  /** What the server does around the commands, by `<project>/<directory>/<command>`, never sent to the interfaces. */
  public automations: Record<string, CommandAutomation>;

  public warnings: string[];

  /** Hosts whose TLS connections the load balancer forwards untouched. */
  public passthrough: PassthroughRule[];

  public dns: DnsDefinition | null;

  public integrations: IntegrationDefinition[];

  /** Where the settings of the configuration come from. */
  private readonly origin: ConfigOrigin;

  /**
   * @param config The raw configuration.
   * @param origin Where its settings come from, for the settings changed from the interface.
   */
  constructor(config: Record<string, unknown>, origin: ConfigOrigin = { sources: {}, localPath: null, sharedPath: null }) {
    this.initialConfig = config;
    this.origin = origin;
    this.adt = defaultAdt();
    this.loadBalancers = {};
    this.passthrough = [];
    this.dns = null;
    this.integrations = [];
    this.projects = {};
    this.automations = {};
    this.warnings = [];
  }

  /**
   * Gives the configuration the server runs with.
   * @returns The configuration read last.
   */
  get runtimeConfig(): RuntimeConfig {
    return {
      adt: this.adt,
      loadBalancers: this.loadBalancers,
      passthrough: this.passthrough,
      dns: this.dns,
      integrations: this.integrations,
      projects: this.projects,
      warnings: this.warnings,
    };
  }

  /**
   * Gives the part of the configuration the interfaces see.
   * @param version The version of the devtool.
   * @returns The configuration sent to the interfaces.
   */
  getForClient(version: string): ClientConfigPayload {
    return {
      version,
      warnings: this.warnings,
      loadBalancers: Object.keys(this.loadBalancers),
      integrations: this.integrations,
      projects: this.projects,
      sidebar: this.adt.sidebar,
      mcp: {
        ...this.adt.mcp,
        port: this.adt.ports.server,
        certificatesByName: Object.fromEntries(Object.entries(this.loadBalancers).map(([domain, certificate]) => [domain.replace(/^\./, ""), { rules: certificate.mcp, target: certificate.mcpTarget }])),
        targets: this.settingTargets(),
        localFile: this.origin.localPath,
      },
    };
  }

  /**
   * Gives where the MCP settings of `adt.mcp` and `environment` are written.
   * @returns The settings and the files declaring them.
   */
  private settingTargets(): ClientConfigPayload["mcp"]["targets"] {
    return {
      default: this.mcpTarget(["adt", "mcp", "default"]),
      ...(Object.fromEntries(MCP_CATEGORIES.map((category) => [category, this.mcpTarget(["adt", "mcp", category])])) as Record<McpCategory, McpTarget>),
      ownTerminals: this.mcpTarget(["adt", "mcp", "ownTerminals"]),
      shell: this.mcpTarget(["adt", "mcp", "shell", "level"]),
      clients: this.mcpTarget(["adt", "mcp", "clients", "level"]),
      environment: this.mcpTarget(["environment", "mcp"]),
    };
  }

  /**
   * Gives the personal override the interfaces write their changes to by default.
   * @returns Its path, null when none is loaded.
   */
  get localPath(): string | null {
    return this.origin.localPath;
  }

  /**
   * Finds where an MCP setting of the configuration is written, among the settings the interfaces may
   * change: those of `adt.mcp` and `environment`, and of the certificates, sections, projects, commands,
   * folders of scripts, scripts and folders of files.
   * @param settingPath The keys leading to the setting.
   * @returns The setting and the file declaring it, null when it is not one of them.
   */
  findMcpTarget(settingPath: string[]): McpTarget | null {
    const directories = Object.values(this.projects).flatMap((project) => Object.values(project.directories));
    const targets = [
      ...Object.values(this.settingTargets()),
      ...Object.values(this.loadBalancers).map((certificate) => certificate.mcpTarget),
      ...Object.values(this.projects).map((project) => project.mcpTarget),
      ...directories.flatMap((directory) => [
        directory.mcpTarget,
        ...Object.values(directory.extras).map((extra) => extra.mcpTarget),
        ...directory.scripts.map((folder) => folder.mcpTarget),
        ...Object.values(directory.files).map((files) => files.mcpTarget),
      ]),
    ];
    return targets.find((target) => target.path.length === settingPath.length && target.path.every((key, index) => key === settingPath[index])) ?? null;
  }

  /**
   * Gives where an MCP setting is written: the last file declaring it, else the first file declaring
   * what holds it, the personal override left out, else the first shared configuration file.
   * @param settingPath The keys leading to the setting in the configuration files.
   * @returns The setting and the file declaring it.
   */
  mcpTarget(settingPath: string[]): McpTarget {
    const declaring = (keys: string[]): string[] => (this.origin.sources[configSourceKey(keys)] ?? []).filter((file) => file !== this.origin.localPath);
    const own = declaring(settingPath).at(-1);
    if (own) {
      return { path: settingPath, declaredIn: own };
    }
    for (let length = settingPath.length - 1; length > 0; length -= 1) {
      const holder = declaring(settingPath.slice(0, length))[0];
      if (holder) {
        return { path: settingPath, declaredIn: holder };
      }
    }
    return { path: settingPath, declaredIn: this.origin.sharedPath };
  }

  /**
   * Reads the raw configuration again from scratch, every invalid setting becoming a warning.
   */
  async reconfigure(): Promise<void> {
    this.adt = defaultAdt();
    this.loadBalancers = {};
    this.passthrough = [];
    this.dns = null;
    this.integrations = [];
    this.projects = {};
    this.automations = {};
    this.warnings = [];

    try {
      await this.reconfigureAdt();
    } catch (error) {
      this.addWarning("adt", error instanceof Error ? error.message : "Unknown adt error");
    }
    this.adt.mcp = this.readMcp(toRecord(this.initialConfig.adt).mcp);

    try {
      await this.reconfigureLoadBalancers();
    } catch (error) {
      this.addWarning("loadBalancers", error instanceof Error ? error.message : "Unknown load balancer error");
    }

    this.passthrough = this.readPassthrough("passthrough", this.initialConfig.passthrough);
    this.dns = this.readDns("dns", this.initialConfig.dns);
    this.integrations = this.readIntegrations("integrations", this.initialConfig.integrations);

    try {
      await this.reconfigureProjects();
    } catch (error) {
      this.addWarning("projects", error instanceof Error ? error.message : "Unknown projects error");
    }
  }

  /**
   * Reads the settings of the devtool itself, `adt`: its host, interface, cache, shell, ports, access and
   * the optional parts of its sidebar.
   */
  private async reconfigureAdt(): Promise<void> {
    const adt = toRecord(this.initialConfig.adt);
    if (Object.keys(adt).length === 0) {
      return;
    }

    if (typeof adt.host === "string") {
      this.adt.host = adt.host;
    }

    if (typeof adt.uiPath === "string") {
      this.adt.uiPath = adt.uiPath;
    }
    this.adt.cacheDir = resolveCacheFolder(this.initialConfig);

    const adtShell = this.readShell("adt.shell", adt.shell);
    if (adtShell !== null) {
      this.adt.shell = adtShell;
    }

    if (adt.secure === true || adt.secure === false) {
      if (adt.secure && !this.adt.host) {
        this.addWarning("adt.secure", "You have to define adt.host if you want secure connections.");
      } else {
        this.adt.secure = adt.secure;
      }
    }

    if (isObject(adt.ports)) {
      if (Number.isInteger(adt.ports.server) && (adt.ports.server as number) > 0) {
        this.adt.ports.server = adt.ports.server as number;
      }
      if (Number.isInteger(adt.ports.loadBalancer) && (adt.ports.loadBalancer as number) > 0) {
        this.adt.ports.loadBalancer = adt.ports.loadBalancer as number;
      }
    }

    if (adt.notifications === true || adt.notifications === false) {
      this.adt.notifications = adt.notifications;
    }

    this.adt.access = this.readAccess("adt.access", adt.access);

    const hosts = toStringArray(adt.hosts);
    if (hosts) {
      this.adt.hosts = hosts;
    }

    const sidebar = toRecord(adt.sidebar);
    for (const key of Object.keys(this.adt.sidebar) as (keyof SidebarSettings)[]) {
      if (sidebar[key] === true || sidebar[key] === false) {
        this.adt.sidebar[key] = sidebar[key];
      } else if (sidebar[key] !== undefined) {
        this.addWarning(`adt.sidebar.${key}`, "is not a boolean");
      }
    }
  }

  /**
   * Reads the MCP server settings, `adt.mcp`, and the rules of the environment, `environment.mcp`.
   * @param value The raw `adt.mcp`.
   * @returns The settings, defaults for what is missing or invalid.
   */
  private readMcp(value: unknown): McpSettings {
    const settings = defaultMcpSettings(this.adt.notifications);
    const mcp = toRecord(value);
    for (const key of ["enabled", "notifications"] as const) {
      if (mcp[key] === true || mcp[key] === false) {
        settings[key] = mcp[key];
      } else if (mcp[key] !== undefined) {
        this.addWarning(`adt.mcp.${key}`, "is not a boolean");
      }
    }
    if (mcp.timeout !== undefined) {
      if (Number.isInteger(mcp.timeout) && (mcp.timeout as number) > 0) {
        settings.timeout = mcp.timeout as number;
      } else {
        this.addWarning("adt.mcp.timeout", "must be a positive number of seconds");
      }
    }
    if (mcp.ownTerminals === "allow" || mcp.ownTerminals === "ask") {
      settings.ownTerminals = mcp.ownTerminals;
    } else if (mcp.ownTerminals !== undefined) {
      this.addWarning("adt.mcp.ownTerminals", "must be allow or ask");
    }
    settings.default = this.readMcpRules("adt.mcp.default", mcp.default, settings.default, "adt.mcp.default");
    for (const category of MCP_CATEGORIES) {
      settings[category] = this.readMcpRules(`adt.mcp.${category}`, mcp[category], settings.default, `adt.mcp.${category}`);
    }
    settings.clients = this.readMcpPatterns("adt.mcp.clients", mcp.clients, settings.clients);
    settings.shell = this.readMcpPatterns("adt.mcp.shell", mcp.shell, settings.shell);
    settings.environment = this.readMcpRules("environment.mcp", toRecord(this.initialConfig.environment).mcp, settings.default, "environment");
    return settings;
  }

  /**
   * Reads the `mcp` setting of something of the configuration, warning about what is invalid.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @param inherited The rules of what holds it.
   * @param from Names the setting in the rules it declares.
   * @returns The rules.
   */
  private readMcpRules(slug: string, value: unknown, inherited: McpRules, from: string): McpRules {
    const { rules, problems } = readMcpRules(value, inherited, from);
    for (const problem of problems) {
      this.addWarning(slug, problem);
    }
    return rules;
  }

  /**
   * Applies the `mcp` settings of what holds something over the rules of its category, its problems
   * already reported when the settings were read.
   * @param category The rules of the category of the thing.
   * @param layers The settings of what holds it, the most general first.
   * @returns The rules.
   */
  private layeredRules(category: McpRules, layers: McpLayer[]): McpRules {
    return layers.reduce((rules, layer) => readMcpRules(layer.value, rules, layer.from).rules, category);
  }

  /**
   * Reads a level and the patterns overriding it, `{ level, allow, deny }`.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @param defaults The settings when nothing is declared.
   * @returns The level and patterns.
   */
  private readMcpPatterns(slug: string, value: unknown, defaults: McpPatterns): McpPatterns {
    if (value === undefined) {
      return defaults;
    }
    const raw = toRecord(value);
    const patterns: McpPatterns = { ...defaults };
    if (raw.level !== undefined) {
      if (isMcpLevel(raw.level) && raw.level !== "keys") {
        patterns.level = raw.level;
      } else {
        this.addWarning(`${slug}.level`, "must be allow, ask or deny");
      }
    }
    for (const key of ["allow", "deny"] as const) {
      if (raw[key] === undefined) {
        continue;
      }
      const list = toStringArray(raw[key]);
      if (list) {
        patterns[key] = list;
      } else {
        this.addWarning(`${slug}.${key}`, "must be an array of patterns");
      }
    }
    return patterns;
  }

  private async reconfigureLoadBalancers(): Promise<void> {
    const loadBalancers = toRecord(this.initialConfig.loadBalancers);
    for (const [key, value] of Object.entries(loadBalancers)) {
      const options = toRecord(value);
      const domain = key.startsWith(".") ? key : `.${key}`;

      if (!this.checkSlug(`loadBalancers[${key}]`, key)) {
        continue;
      }

      if (!this.checkString(`loadBalancers[${key}].crt`, options.crt)) {
        continue;
      }

      if (!this.checkString(`loadBalancers[${key}].key`, options.key)) {
        continue;
      }

      const warn = options.warn ?? 30;
      if (!Number.isInteger(warn) || (warn as number) < 1) {
        this.addWarning(`loadBalancers[${key}].warn`, "must be a positive number of days");
      }

      this.loadBalancers[domain] = {
        crt: options.crt as string,
        key: options.key as string,
        warn: Number.isInteger(warn) && (warn as number) > 0 ? (warn as number) : 30,
        acme: options.acme === undefined ? null : this.readAcme(`loadBalancers[${key}].acme`, domain.slice(1), options),
        mcp: this.readMcpRules(`loadBalancers[${key}].mcp`, options.mcp, this.adt.mcp.certificates, `loadBalancers.${key}`),
        mcpTarget: this.mcpTarget(["loadBalancers", key, "mcp"]),
      };

      logger.info("Config", "LoadBalancer", domain);
    }
  }

  /**
   * Reads how a certificate of the load balancer is renewed, `{ trigger, before, env, opAccount, unless,
   * answers, lego | command }`, its automation kept under {@link certificateAutomationKey}.
   * @param slug Names the setting in warnings.
   * @param name The name of the certificate in the configuration.
   * @param certificate The raw certificate, whose `crt` and `key` must be files.
   * @returns The renewal, null when invalid.
   */
  private readAcme(slug: string, name: string, certificate: Record<string, unknown>): CertificateAcme | null {
    const acme = toRecord(certificate.acme);
    if ([certificate.crt, certificate.key].some((file) => String(file).trimStart().startsWith("-----BEGIN "))) {
      this.addWarning(slug, "needs crt and key to be files, not PEM texts");
      return null;
    }
    if ((acme.lego === undefined) === (acme.command === undefined)) {
      this.addWarning(slug, "needs either lego or command");
      return null;
    }
    const trigger = acme.trigger ?? "button";
    if (trigger !== "button" && trigger !== "auto" && trigger !== "both") {
      this.addWarning(`${slug}.trigger`, "must be button, auto or both");
      return null;
    }
    const before = acme.before ?? 30;
    if (!Number.isInteger(before) || (before as number) < 1) {
      this.addWarning(`${slug}.before`, "must be a positive number of days");
      return null;
    }

    const lego = acme.lego === undefined ? null : this.readLegoOptions(`${slug}.lego`, acme.lego);
    const command = acme.command === undefined ? null : toCommandArgsArray(acme.command);
    if (acme.command !== undefined && !command?.length) {
      this.addWarning(`${slug}.command`, "must be a non-empty array of strings or numbers");
      return null;
    }
    const env = toStringRecord(acme.env) ?? {};
    const automation = this.readAutomation(slug, acme, command ?? legoRunArgs(lego ?? {}), env);
    if (automation) {
      this.automations[certificateAutomationKey(name)] = automation;
    }
    return { trigger, before: before as number, env, lego, command };
  }

  /**
   * Reads the options of `lego run`, the ones the devtool sets itself left out.
   * @param slug Names the setting in warnings.
   * @param value The raw options, by name without their dashes.
   * @returns The valid options.
   */
  private readLegoOptions(slug: string, value: unknown): Record<string, LegoOptionValue> {
    const options: Record<string, LegoOptionValue> = {};
    for (const [name, option] of Object.entries(toRecord(value))) {
      const valid =
        ["string", "number", "boolean"].includes(typeof option) ||
        (Array.isArray(option) && option.every((item) => typeof item === "string" || typeof item === "number"));
      if (LEGO_OWNED_OPTIONS.includes(name)) {
        this.addWarning(`${slug}.${name}`, "is set by the devtool");
      } else if (!valid) {
        this.addWarning(`${slug}.${name}`, "must be a string, a number, a boolean or a list of strings or numbers");
      } else {
        options[name] = option as LegoOptionValue;
      }
    }
    return options;
  }

  private async reconfigureProjects(): Promise<void> {
    const projects = toRecord(this.initialConfig.projects);
    for (const [projectSlug, projectRaw] of Object.entries(projects)) {
      const project = toRecord(projectRaw);
      try {
        await this.reconfigureProject(`projects[${projectSlug}]`, projectSlug, project);
      } catch (error) {
        this.addWarning(`projects[${projectSlug}]`, error instanceof Error ? error.message : "Invalid project");
      }
    }
  }

  private async reconfigureProject(slug: string, projectSlug: string, project: Record<string, unknown>): Promise<void> {
    if (!this.checkSlug(slug, projectSlug)) {
      return;
    }

    const projectName = this.checkString(`${slug}.name`, project.name) ? (project.name as string) : projectSlug;
    if (!this.checkString(`${slug}.path`, project.path)) {
      return;
    }
    if (!path.isAbsolute(project.path as string)) {
      this.addWarning(`${slug}.path`, "is relative to the workspace, which is not declared (workspace: <folder>)");
      return;
    }

    const projectPath = this.pathFrom(project.path as string);
    const layers: McpLayer[] = [{ value: project.mcp, from: `sections.${projectSlug}` }];
    const projectDefinition: ProjectDefinition = {
      slug: projectSlug,
      name: projectName,
      description: typeof project.description === "string" ? project.description : null,
      path: projectPath,
      directories: {},
      notifications: project.notifications === false ? false : this.adt.notifications,
      missing: false,
      restore: this.readRestore(`${slug}.restore`, project.restore),
      mcp: this.readMcpRules(`${slug}.mcp`, project.mcp, this.adt.mcp.default, `sections.${projectSlug}`),
      mcpTarget: this.mcpTarget(["sections", projectSlug, "mcp"]),
      restoreRule: this.layeredRules(this.adt.mcp.commands, layers).run,
      meta: project.meta,
    };

    const exists = await fs.stat(projectPath).then((stat) => stat.isDirectory(), () => false);
    if (!exists && projectDefinition.restore) {
      this.projects[projectSlug] = { ...projectDefinition, missing: true };
      return;
    }
    if (!(await this.checkDirectory(`${slug}.path`, projectPath, true))) {
      return;
    }

    const directoriesRecord = toRecord(project.directories);
    if (!Object.keys(directoriesRecord).length) {
      this.addWarning(`${slug}.directories`, "is empty");
      return;
    }

    if (project.notifications === true || project.notifications === false) {
      projectDefinition.notifications = project.notifications;
    }

    for (const [directorySlug, directoryRaw] of Object.entries(directoriesRecord)) {
      const directory = toRecord(directoryRaw);
      try {
        await this.reconfigureProjectDirectory(`${slug}.directories[${directorySlug}]`, projectDefinition, directorySlug, directory, layers);
      } catch (error) {
        this.addWarning(`${slug}.directories[${directorySlug}]`, error instanceof Error ? error.message : "Invalid directory");
      }
    }

    if (!Object.keys(projectDefinition.directories).length) {
      this.addWarning(`${slug}.directories`, "contains no valid entries");
      return;
    }

    this.projects[projectSlug] = projectDefinition;
  }

  /**
   * Reads a directory of a project: its commands, services, scripts, files and integrations, its main
   * command being the command its default action names, else its own `args`.
   * @param slug Names the directory in warnings.
   * @param projectDefinition The project receiving the directory.
   * @param directorySlug The slug of the directory.
   * @param directory The raw directory.
   * @param sectionLayers The `mcp` settings of its project, applied over the rules of each category.
   */
  private async reconfigureProjectDirectory(
    slug: string,
    projectDefinition: ProjectDefinition,
    directorySlug: string,
    directory: Record<string, unknown>,
    sectionLayers: McpLayer[],
  ): Promise<void> {
    const layers: McpLayer[] = [...sectionLayers, { value: directory.mcp, from: `projects.${directorySlug}` }];
    if (!this.checkSlug(slug, directorySlug)) {
      return;
    }

    const directoryName = this.checkString(`${slug}.name`, directory.name) ? (directory.name as string) : directorySlug;
    const relativePath = this.checkString(`${slug}.path`, directory.path) ? (directory.path as string) : directorySlug;
    const directoryPath = this.pathFrom(projectDefinition.path, relativePath);

    const action = toRecord(directory.default).action;
    const mainCommand = typeof action === "string" && action.startsWith("command:") ? action.slice("command:".length) : null;
    const args = mainCommand || directory.args === undefined || directory.args === null ? null : this.readCommandArgs(`${slug}.args`, directory.args);
    if (!mainCommand && directory.args !== undefined && directory.args !== null && !args) {
      return;
    }

    const directoryDefinition: DirectoryDefinition = {
      slug: directorySlug,
      name: directoryName,
      description: typeof directory.description === "string" ? directory.description : null,
      path: directoryPath,
      loadBalancer: {},
      args,
      extras: {},
      scripts: [],
      files: {},
      defaultAction: null,
      integrations: [],
      icons: [],
      lines: [],
      notifications: directory.notifications === false ? false : projectDefinition.notifications,
      env: {},
      shell: this.adt.shell,
      killSignal: null,
      missing: false,
      restore: this.readRestore(`${slug}.restore`, directory.restore),
      mcp: this.readMcpRules(`${slug}.mcp`, directory.mcp, projectDefinition.mcp, `projects.${directorySlug}`),
      mcpTarget: this.mcpTarget(["projects", directorySlug, "mcp"]),
      restoreRule: this.layeredRules(this.adt.mcp.commands, layers).run,
      meta: directory.meta,
    };

    const exists = await fs.stat(directoryPath).then((stat) => stat.isDirectory(), () => false);
    if (!exists && directoryDefinition.restore) {
      projectDefinition.directories[directorySlug] = { ...directoryDefinition, missing: true };
      return;
    }
    if (!(await this.checkDirectory(`${slug}.path`, directoryPath))) {
      return;
    }

    if (directory.notifications === true || directory.notifications === false) {
      directoryDefinition.notifications = directory.notifications;
    }

    const env = toStringRecord(directory.env);
    if (env) {
      directoryDefinition.env = env;
    }

    const directoryShell = this.readShell(
      `${slug}.shell`,
      directory.shell,
    );
    if (directoryShell !== null) {
      directoryDefinition.shell = directoryShell;
    }

    const directoryKillSignal = this.readKillSignal(
      `${slug}.killSignal`,
      directory.killSignal ?? directory.killsignal,
    );
    if (directoryKillSignal !== null) {
      directoryDefinition.killSignal = directoryKillSignal;
    }

    const lbRecord = toRecord(directory.loadBalancer);
    for (const [lbSlug, lbRaw] of Object.entries(lbRecord)) {
      const lb = toRecord(lbRaw);
      const setting = `${slug}.services[${lbSlug}]`;
      for (const replaced of ["ports", "urls", "url"].filter((key) => key in lb)) {
        this.addWarning(`${setting}.${replaced}`, "is replaced by target: <port> | <host>:<port> | <URL>, or a list of them");
      }

      const rawHosts = lb.hosts ?? lb.host;
      const hosts = typeof rawHosts === "string" ? [rawHosts] : toStringArray(rawHosts);
      if (!hosts?.length) {
        this.addWarning(`${setting}.host`, "must be a host name or a list of host names");
        continue;
      }
      const targets = this.readTargets(`${setting}.target`, lb.target);
      if (!targets) {
        continue;
      }

      const tls = lb.tls === true;
      if ("tls" in lb && lb.tls !== true && lb.tls !== false) {
        this.addWarning(`${setting}.tls`, "is not a boolean");
        continue;
      }

      if (lb.path && !this.checkString(`${setting}.path`, lb.path)) {
        continue;
      }
      if (lb.prefix && !this.checkString(`${setting}.prefix`, lb.prefix)) {
        continue;
      }
      if (lb.pathNot && !this.checkString(`${setting}.pathNot`, lb.pathNot)) {
        continue;
      }

      const preserveHost = lb.preserveHost === true;
      if ("preserveHost" in lb && lb.preserveHost !== true && lb.preserveHost !== false) {
        this.addWarning(`${setting}.preserveHost`, "is not a boolean");
        continue;
      }

      directoryDefinition.loadBalancer[lbSlug] = {
        slug: lbSlug,
        hosts,
        targets,
        tls,
        path: typeof lb.path === "string" ? lb.path : null,
        prefix: typeof lb.prefix === "string" ? lb.prefix : null,
        pathNot: typeof lb.pathNot === "string" ? lb.pathNot : null,
        preserveHost,
        access: this.readAccess(`${setting}.access`, lb.access),
      };
    }

    const extras = toRecord(directory.extras);
    for (const [extraSlug, extraRaw] of Object.entries(extras)) {
      if (extraSlug === "default") {
        this.addWarning(`${slug}.commands.default`, "is replaced by default: { action: command:<slug> }");
        continue;
      }
      const extra = toRecord(extraRaw);
      const extraArgs = this.readCommandArgs(`${slug}.extras[${extraSlug}].args`, extra.args);
      if (!extraArgs) {
        continue;
      }

      const extraName = this.checkString(`${slug}.extras[${extraSlug}].name`, extra.name) ? (extra.name as string) : extraSlug;
      const extraEnv = toStringRecord(extra.env) ?? {};
      const automation = this.readAutomation(`${slug}.extras[${extraSlug}]`, extra, extraArgs, extraEnv);
      if (automation) {
        this.automations[`${projectDefinition.slug}/${directorySlug}/${extraSlug}`] = automation;
      }

      directoryDefinition.extras[extraSlug] = {
        slug: extraSlug,
        name: extraName,
        args: extraArgs,
        detached: extra.detached === true,
        prompt: extra.prompt === true,
        form: this.readForm(`${slug}.extras[${extraSlug}].form`, extra.form) ?? "dialog",
        automated: automation !== null,
        startWithSection: extra.startWithSection === true,
        notifications: extra.notifications === false ? false : directoryDefinition.notifications,
        env: extraEnv,
        shell: this.readShell(
          `${slug}.extras[${extraSlug}].shell`,
          extra.shell,
        ) ?? directoryDefinition.shell,
        killSignal: this.readKillSignal(
          `${slug}.extras[${extraSlug}].killSignal`,
          extra.killSignal ?? extra.killsignal,
        ),
        script: null,
        mcp: this.readMcpRules(`${slug}.extras[${extraSlug}].mcp`, extra.mcp, this.layeredRules(this.adt.mcp.commands, layers), `projects.${directorySlug}.commands.${extraSlug}`),
        mcpTarget: this.mcpTarget(["projects", directorySlug, "commands", extraSlug, "mcp"]),
        meta: extra.meta,
      };
    }

    directoryDefinition.scripts = await this.readScripts(`${slug}.scripts`, directoryPath, directory.scripts, this.layeredRules(this.adt.mcp.scripts, layers), ["projects", directorySlug, "scripts"]);
    const scripts = await listScripts(directoryDefinition).catch((error: unknown) => {
      this.addWarning(`${slug}.scripts`, error instanceof Error ? error.message : String(error));
      return [];
    });
    for (const script of scripts) {
      if (script.slug in directoryDefinition.extras) {
        this.addWarning(`${slug}.scripts`, `${script.slug} is hidden by the command of the same slug`);
        continue;
      }
      directoryDefinition.extras[script.slug] = script;
    }
    if (mainCommand) {
      directoryDefinition.args = directoryDefinition.extras[mainCommand]?.args ?? null;
    }
    directoryDefinition.files = this.readFiles(`${slug}.files`, directoryDefinition, directory.files, this.layeredRules(this.adt.mcp.files, layers));
    directoryDefinition.integrations = this.readIntegrations(`${slug}.integrations`, directory.integrations);
    directoryDefinition.defaultAction = this.readDefaultAction(`${slug}.default`, directoryDefinition, directory.default);
    directoryDefinition.icons = this.readShortcuts(`${slug}.icons`, directoryDefinition, directory.icons);
    directoryDefinition.lines = this.readShortcuts(`${slug}.lines`, directoryDefinition, directory.lines);

    projectDefinition.directories[directorySlug] = directoryDefinition;
  }

  /**
   * Reads the command bringing back the folder of a project when it is missing, `{ name, args }`.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @returns The command, null when none is declared or it is invalid.
   */
  private readRestore(slug: string, value: unknown): ProjectRestore | null {
    if (value === undefined) {
      return null;
    }

    const restore = toRecord(value);
    const args = toCommandArgsArray(restore.args);
    if (!args?.length) {
      this.addWarning(`${slug}.args`, "must be a non-empty array of strings or numbers");
      return null;
    }
    return { name: typeof restore.name === "string" ? restore.name : "Restore", args };
  }

  /**
   * Reads who reaches a host through the load balancer.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @returns `network` when declared, `local` otherwise.
   */
  private readAccess(slug: string, value: unknown): HostAccess {
    if (value === undefined || value === "local" || value === "network") {
      return value ?? "local";
    }

    this.addWarning(slug, "must be local or network, local is used");
    return "local";
  }

  /**
   * Reads the hosts whose TLS connections the load balancer forwards untouched, each
   * `{ hosts, target: <host>:<port>, access }`.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @returns The valid rules.
   */
  private readPassthrough(slug: string, value: unknown): PassthroughRule[] {
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value)) {
      this.addWarning(slug, "must be an array");
      return [];
    }

    const rules: PassthroughRule[] = [];
    for (const [index, raw] of value.entries()) {
      const rule = toRecord(raw);
      const hosts = toStringArray(rule.hosts)?.map((host) => host.toLowerCase());
      const target = typeof rule.target === "string" ? /^(.+):(\d+)$/.exec(rule.target) : null;
      if (!hosts?.length || hosts.some((host) => !HOST_PATTERN_REGEXP.test(host))) {
        this.addWarning(`${slug}[${index}].hosts`, "must be host names or *.<domain>");
        continue;
      }
      if (!target) {
        this.addWarning(`${slug}[${index}].target`, "must be <host>:<port>");
        continue;
      }

      rules.push({ hosts, host: target[1], port: Number(target[2]), access: this.readAccess(`${slug}[${index}].access`, rule.access) });
    }
    return rules;
  }

  /**
   * Reads the local DNS: `{ port, access, records: { <slug>: { names, address } } }`, the records being
   * a map so personal configuration files add their own.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @returns The DNS, null when it declares no valid record.
   */
  private readDns(slug: string, value: unknown): DnsDefinition | null {
    if (value === undefined) {
      return null;
    }

    const dns = toRecord(value);
    const records: DnsRecord[] = [];
    for (const [recordSlug, raw] of Object.entries(toRecord(dns.records))) {
      const record = toRecord(raw);
      const names = toStringArray(record.names)?.map((name) => name.toLowerCase());
      if (!names?.length || names.some((name) => !HOST_PATTERN_REGEXP.test(name))) {
        this.addWarning(`${slug}.records[${recordSlug}].names`, "must be host names or *.<domain>");
        continue;
      }
      if (typeof record.address !== "string" || (record.address !== "auto" && !net.isIPv4(record.address))) {
        this.addWarning(`${slug}.records[${recordSlug}].address`, "must be an IPv4 address or auto");
        continue;
      }
      records.push({ names, address: record.address });
    }

    const port = dns.port === undefined ? 53 : Number(dns.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      this.addWarning(`${slug}.port`, "must be a port number");
      return null;
    }
    return records.length ? { port, access: this.readAccess(`${slug}.access`, dns.access), records } : null;
  }

  /**
   * Reads the integrations, `{ <slug>: { name, url, icon, embed } }`, in the order they are declared.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @returns The valid integrations.
   */
  private readIntegrations(slug: string, value: unknown): IntegrationDefinition[] {
    if (value === undefined) {
      return [];
    }
    if (!isObject(value)) {
      this.addWarning(slug, "must be a map of integrations");
      return [];
    }

    const integrations: IntegrationDefinition[] = [];
    for (const [integrationSlug, raw] of Object.entries(value)) {
      const integration = toRecord(raw);
      const setting = `${slug}.${integrationSlug}`;
      if (!this.checkSlug(setting, integrationSlug) || !this.checkString(`${setting}.name`, integration.name)) {
        continue;
      }
      if (typeof integration.url !== "string" || !/^https?:\/\/[^/]/.test(integration.url)) {
        this.addWarning(`${setting}.url`, "must be an http or https URL");
        continue;
      }
      if (integration.icon !== undefined && !this.checkString(`${setting}.icon`, integration.icon)) {
        continue;
      }
      if (integration.embed !== undefined && typeof integration.embed !== "boolean") {
        this.addWarning(`${setting}.embed`, "must be true or false");
        continue;
      }

      integrations.push({
        slug: integrationSlug,
        name: integration.name as string,
        icon: (integration.icon as string | undefined) ?? DEFAULT_INTEGRATION_ICON,
        url: integration.url,
        embed: integration.embed ?? true,
      });
    }
    return integrations;
  }

  /**
   * Reads a list of shortcuts of a directory, each `integration:<slug>`, `command:<slug>`,
   * `files:<slug>` or `service:<slug>[:<host index>]`, keeping those naming something of the directory.
   * @param slug Names the setting in warnings.
   * @param directory The directory, its integrations, commands, files and services already read.
   * @param value The raw setting.
   * @returns The valid shortcuts, in order.
   */
  private readShortcuts(slug: string, directory: DirectoryDefinition, value: unknown): DirectoryShortcut[] {
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value)) {
      this.addWarning(slug, "must be a list of <type>:<slug>");
      return [];
    }
    return value.flatMap((entry, index) => this.readShortcut(`${slug}[${index}]`, directory, entry) ?? []);
  }

  /**
   * Reads one shortcut of a directory, `integration:<slug>`, `command:<slug>`, `files:<slug>` or
   * `service:<slug>[:<host index>]`.
   * @param slug Names the setting in warnings.
   * @param directory The directory, its integrations, commands, files and services already read.
   * @param value The raw shortcut.
   * @returns The shortcut, null when it names nothing of the directory.
   */
  private readShortcut(slug: string, directory: DirectoryDefinition, value: unknown): DirectoryShortcut | null {
    if (typeof value !== "string") {
      this.addWarning(slug, "must be <type>:<slug>");
      return null;
    }

    const [type, target = "", hostIndex = "0"] = value.split(":");
    const shortcut = { type, slug: target, index: Number(hostIndex) } as DirectoryShortcut;
    const exists =
      (type === "integration" && directory.integrations.some((integration) => integration.slug === target)) ||
      (type === "command" && target in directory.extras) ||
      (type === "files" && target in directory.files) ||
      (type === "service" && Number.isInteger(shortcut.index) && directory.loadBalancer[target]?.hosts[shortcut.index] !== undefined);
    if (!exists) {
      this.addWarning(slug, `${value} names no integration, command, files or service host of the directory`);
      return null;
    }
    return shortcut;
  }

  /**
   * Reads what the server does on its own around a command: `unless`, a command whose success skips
   * it, `answers`, `{ match, value }` typed when the output asks `match`, and the value blocks of its
   * arguments, environment and answers, `{{ op://… }}` read from `opAccount` or `{{ $(…) }}`.
   * @param slug Names the command in warnings.
   * @param command The raw command.
   * @param args The arguments of the command, whose inputs hold no value block.
   * @param env The environment of the command.
   * @returns The automation, null when the command declares none.
   */
  private readAutomation(slug: string, command: Record<string, unknown>, args: CommandArg[], env: Record<string, string>): CommandAutomation | null {
    const values = [
      ...args.flatMap((arg, index) => (typeof arg === "string" ? [{ slug: `${slug}.args[${index}]`, text: arg }] : [])),
      ...Object.entries(env).map(([key, value]) => ({ slug: `${slug}.env.${key}`, text: value })),
      ...(Array.isArray(command.answers) ? command.answers : []).map((raw, index) => ({ slug: `${slug}.answers[${index}].value`, text: String(toRecord(raw).value ?? "") })),
    ];
    for (const value of values) {
      for (const block of findInvalidValueBlocks(value.text)) {
        this.addWarning(value.slug, `unknown value block ${block}, expected {{ op://… }} or {{ $(…) }}`);
      }
    }

    const hasBlocks = values.some((value) => value.text.includes("{{"));
    if (!hasBlocks && command.unless === undefined && command.answers === undefined && command.opAccount === undefined) {
      return null;
    }

    const unless = command.unless === undefined ? null : toCommandArgsArray(command.unless);
    if (command.unless !== undefined && !unless) {
      this.addWarning(`${slug}.unless`, "must be an array of strings or numbers");
    }

    const answers: CommandAnswer[] = [];
    for (const [index, raw] of (Array.isArray(command.answers) ? command.answers : []).entries()) {
      const answer = toRecord(raw);
      if (typeof answer.match !== "string" || typeof answer.value !== "string") {
        this.addWarning(`${slug}.answers[${index}]`, "must be { match, value }");
        continue;
      }
      try {
        answers.push({ pattern: new RegExp(answer.match, "i"), value: answer.value });
      } catch {
        this.addWarning(`${slug}.answers[${index}].match`, "is not a valid regular expression");
      }
    }

    return { unless, opAccount: typeof command.opAccount === "string" ? command.opAccount : null, answers };
  }

  /**
   * Reads the folders whose executables a directory offers as scripts, each given as its path or as
   * `{ path, prompt, form, only, mcp, scripts }`.
   * @param slug Names the setting in warnings.
   * @param directoryPath Absolute path of the directory, relative folders are resolved from it.
   * @param value The raw setting.
   * @param inherited The MCP rules of the directory.
   * @param settingPath The keys leading to the setting in the configuration files.
   * @returns The existing folders.
   */
  private async readScripts(slug: string, directoryPath: string, value: unknown, inherited: McpRules, settingPath: string[]): Promise<DirectoryScripts[]> {
    const from = settingPath.join(".");
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value)) {
      this.addWarning(slug, "must be an array");
      return [];
    }

    const folders: DirectoryScripts[] = [];
    for (const [index, raw] of value.entries()) {
      const folder = typeof raw === "string" ? { path: raw } : toRecord(raw);
      if (!this.checkString(`${slug}[${index}].path`, folder.path)) {
        continue;
      }

      const folderPath = this.pathFrom(directoryPath, folder.path as string);
      if (!(await this.checkDirectory(`${slug}[${index}]`, folderPath))) {
        continue;
      }

      const mcp = this.readMcpRules(`${slug}[${index}].mcp`, folder.mcp, inherited, `${from}[${index}]`);
      const folderSetting = [...settingPath, String(index)];
      const scripts: Record<string, ScriptSettings> = {};
      for (const [name, settingsRaw] of Object.entries(toRecord(folder.scripts))) {
        const settings = toRecord(settingsRaw);
        scripts[name] = {
          prompt: typeof settings.prompt === "boolean" ? settings.prompt : null,
          args: settings.args === undefined ? null : this.readCommandArgs(`${slug}[${index}].scripts[${name}].args`, settings.args),
          form: this.readForm(`${slug}[${index}].scripts[${name}].form`, settings.form),
          mcp: this.readMcpRules(`${slug}[${index}].scripts[${name}].mcp`, settings.mcp, mcp, `${from}[${index}].scripts.${name}`),
          mcpTarget: this.mcpTarget([...folderSetting, "scripts", name, "mcp"]),
        };
      }
      const only = folder.only === undefined ? null : toStringArray(folder.only);
      if (folder.only !== undefined && !only) {
        this.addWarning(`${slug}[${index}].only`, "must be an array of glob patterns");
      }
      folders.push({ path: folderPath, prompt: folder.prompt === true, form: this.readForm(`${slug}[${index}].form`, folder.form) ?? "inline", only, scripts, mcp, mcpTarget: this.mcpTarget([...folderSetting, "mcp"]) });
    }
    return folders;
  }

  /**
   * Reads where the page of a directory asks for the inputs of a command, `dialog` or `inline`.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @returns The form, null when the setting is missing or invalid.
   */
  private readForm(slug: string, value: unknown): CommandForm | null {
    if (value === "dialog" || value === "inline") {
      return value;
    }
    if (value !== undefined) {
      this.addWarning(slug, "must be dialog or inline");
    }
    return null;
  }

  /**
   * Reads the arguments of a command: strings, numbers and inputs typed when it starts, each
   * `{ name, choices, optional, display: buttons | dropdown }`, `{ name, flag: true }` or
   * `{ name, text: true }`; invalid entries are left out.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @returns The arguments, in order, null when the setting is not a list.
   */
  private readCommandArgs(slug: string, value: unknown): CommandArg[] | null {
    if (!Array.isArray(value)) {
      this.addWarning(slug, "must be an array of strings, numbers or inputs");
      return null;
    }

    const args: CommandArg[] = [];
    for (const [index, raw] of value.entries()) {
      if (typeof raw === "string" || (typeof raw === "number" && Number.isFinite(raw))) {
        args.push(String(raw));
        continue;
      }

      const input = this.readCommandInput(`${slug}[${index}]`, raw);
      if (input) {
        args.push(input);
      }
    }
    return args;
  }

  /**
   * Reads the choices of an input, each a value or `{ label, value }`; invalid ones are left out.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @returns The choices, null when the setting is not a list.
   */
  private readChoices(slug: string, value: unknown): CommandChoice[] | null {
    if (!Array.isArray(value)) {
      return null;
    }

    return value.flatMap((raw, index) => {
      const choice = typeof raw === "string" || typeof raw === "number" ? { value: raw } : toRecord(raw);
      if (typeof choice.value !== "string" && typeof choice.value !== "number") {
        this.addWarning(`${slug}[${index}]`, "must be a value or { label, value }");
        return [];
      }
      const choiceValue = String(choice.value);
      return [{ label: typeof choice.label === "string" ? choice.label : choiceValue, value: choiceValue }];
    });
  }

  /**
   * Reads an input of a command, `{ name, choices, optional, display, default }`, `{ name, flag: true, default }`
   * or `{ name, text: true, default }`.
   * @param slug Names the input in warnings.
   * @param value The raw input.
   * @returns The input, null when invalid.
   */
  private readCommandInput(slug: string, value: unknown): CommandInput | null {
    const input = toRecord(value);
    if (!this.checkString(`${slug}.name`, input.name)) {
      return null;
    }

    const name = input.name as string;
    const choices = this.readChoices(`${slug}.choices`, input.choices);
    let parsed: CommandInput;
    if (choices?.length) {
      if (input.display !== undefined && input.display !== "buttons" && input.display !== "dropdown") {
        this.addWarning(`${slug}.display`, "must be buttons or dropdown");
      }
      parsed = { name, kind: "choice", choices, display: input.display === "dropdown" ? "dropdown" : "buttons", optional: input.optional === true, default: null };
    } else if (input.flag === true || input.text === true) {
      parsed = { name, kind: input.flag === true ? "flag" : "text", choices: [], display: "buttons", optional: true, default: null };
    } else {
      this.addWarning(slug, "must be a string, a number, or an input with choices, flag: true or text: true");
      return null;
    }

    const fallback = typeof input.default === "number" ? String(input.default) : input.default;
    const valid =
      (parsed.kind === "choice" && typeof fallback === "string" && parsed.choices.some((choice) => choice.value === fallback)) ||
      (parsed.kind === "flag" && typeof fallback === "boolean") ||
      (parsed.kind === "text" && typeof fallback === "string");
    if (fallback !== undefined && fallback !== null && !valid) {
      this.addWarning(`${slug}.default`, parsed.kind === "choice" ? "must be one of the choices" : parsed.kind === "flag" ? "must be a boolean" : "must be a string");
    }
    return { ...parsed, default: valid ? (fallback as CommandInputValue) : null };
  }

  /**
   * Reads what a directory does by default, `{ action: <type>:<slug>, trigger: icon | row | row-icon, icon: own | <prefix>:<name> }`.
   * @param slug Names the setting in warnings.
   * @param directory The directory, its integrations, commands, files and services already read.
   * @param value The raw setting.
   * @returns The default action, null when there is none.
   */
  private readDefaultAction(slug: string, directory: DirectoryDefinition, value: unknown): DirectoryDefaultAction | null {
    if (value === undefined) {
      return null;
    }

    const setting = toRecord(value);
    const shortcut = this.readShortcut(`${slug}.action`, directory, setting.action);
    if (setting.trigger !== undefined && setting.trigger !== "icon" && setting.trigger !== "row" && setting.trigger !== "row-icon") {
      this.addWarning(`${slug}.trigger`, "must be icon, row or row-icon");
      return null;
    }
    if (setting.icon !== undefined && (typeof setting.icon !== "string" || (setting.icon !== "own" && !setting.icon.includes(":")))) {
      this.addWarning(`${slug}.icon`, "must be own or an Iconify name <prefix>:<name>");
      return null;
    }
    return shortcut ? { shortcut, trigger: setting.trigger ?? "icon", icon: setting.icon ?? null } : null;
  }

  /**
   * Reads where a service sends its requests: a port of this machine, `<host>:<port>` or an http(s)
   * URL, or a list of them shared in turn.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @returns The targets as URLs, null when one of them is invalid or none is given.
   */
  private readTargets(slug: string, value: unknown): string[] | null {
    const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
    if (!entries.length) {
      this.addWarning(slug, "must be <port> | <host>:<port> | <URL>, or a list of them");
      return null;
    }

    const targets: string[] = [];
    for (const entry of entries) {
      const text = typeof entry === "number" ? `127.0.0.1:${entry}` : typeof entry === "string" ? entry.trim() : "";
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
      const url = URL.parse(withScheme ? text : `http://${text}`);
      if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || (!withScheme && !/:\d+$/.test(text))) {
        this.addWarning(slug, `${String(entry)} is not a port, <host>:<port> or http(s) URL`);
        return null;
      }
      targets.push(url.toString());
    }
    return targets;
  }

  /**
   * Reads the folders of editable files a directory declares, which may not exist yet.
   * @param slug Names the setting in warnings.
   * @param directory The directory, its extras already read.
   * @param value The raw setting.
   * @param inherited The MCP rules of the folders of files of the directory.
   * @returns The folders by slug.
   */
  private readFiles(slug: string, directory: DirectoryDefinition, value: unknown, inherited: McpRules): Record<string, DirectoryFiles> {
    const files: Record<string, DirectoryFiles> = {};
    for (const [filesSlug, filesRaw] of Object.entries(toRecord(value))) {
      if (filesSlug === "default") {
        this.addWarning(`${slug}.default`, "is replaced by default: { action: files:<slug> }");
        continue;
      }

      const entry = toRecord(filesRaw);
      if (!this.checkSlug(`${slug}[${filesSlug}]`, filesSlug) || !this.checkString(`${slug}[${filesSlug}].path`, entry.path)) {
        continue;
      }

      const commands = toStringArray(entry.commands) ?? [];
      const unknownCommands = commands.filter((command) => !(command in directory.extras));
      if (unknownCommands.length) {
        this.addWarning(`${slug}[${filesSlug}].commands`, `unknown commands ${unknownCommands.join(", ")}`);
      }
      const restore = typeof entry.restore === "string" && entry.restore in directory.extras ? entry.restore : null;
      if (entry.restore !== undefined && !restore) {
        this.addWarning(`${slug}[${filesSlug}].restore`, "must name a command of the directory");
      }

      files[filesSlug] = {
        slug: filesSlug,
        name: typeof entry.name === "string" ? entry.name : filesSlug,
        path: this.pathFrom(directory.path, entry.path as string),
        restore,
        commands: commands.filter((command) => command in directory.extras),
        mcp: this.readMcpRules(`${slug}[${filesSlug}].mcp`, entry.mcp, inherited, `projects.${directory.slug}.files.${filesSlug}`),
        mcpTarget: this.mcpTarget(["projects", directory.slug, "files", filesSlug, "mcp"]),
      };
    }
    return files;
  }

  private pathFrom(projectPath: string, directoryPath?: string): string {
    const base = path.isAbsolute(projectPath) ? projectPath : path.join(process.cwd(), projectPath);
    if (!directoryPath) {
      return base;
    }
    return path.isAbsolute(directoryPath) ? directoryPath : path.join(base, directoryPath);
  }

  private async checkDirectory(slug: string, directory: string, mustBeAbsolute = false): Promise<boolean> {
    try {
      if (mustBeAbsolute && !path.isAbsolute(directory)) {
        throw new Error("must be an absolute directory");
      }

      const stat = await fs.stat(directory);
      if (!stat.isDirectory()) {
        throw new Error("not a directory");
      }
      return true;
    } catch (error) {
      this.addWarning(slug, error instanceof Error ? error.message : "invalid directory");
      return false;
    }
  }

  private checkSlug(slug: string, value: unknown): boolean {
    if (typeof value !== "string") {
      this.addWarning(slug, "is not a string");
      return false;
    }

    if (!SLUG_REGEXP.test(value)) {
      this.addWarning(slug, "is not a slug (a-z0-9-/_.)");
      return false;
    }

    return true;
  }

  private checkString(slug: string, value: unknown): boolean {
    if (typeof value !== "string") {
      this.addWarning(slug, "is not a string");
      return false;
    }

    return true;
  }

  private readKillSignal(slug: string, value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== "string") {
      this.addWarning(slug, "is not a string");
      return null;
    }

    const normalized = value.trim().toUpperCase();
    if (!normalized.length) {
      return null;
    }

    if (!SIGNAL_REGEXP.test(normalized)) {
      this.addWarning(slug, "must match SIG* format (example: SIGTERM, SIGKILL)");
      return null;
    }

    return normalized;
  }

  private readShell(slug: string, value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== "string") {
      this.addWarning(slug, "is not a string");
      return null;
    }

    const normalized = value.trim();
    if (!normalized.length) {
      return null;
    }

    return normalized;
  }

  private addWarning(slug: string, message: string): false {
    logger.warn("Config", slug, message);
    this.warnings.push(`${slug}: ${message}.`);
    return false;
  }
}
