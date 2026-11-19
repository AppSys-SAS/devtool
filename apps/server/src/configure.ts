import path from "node:path";
import fs from "node:fs/promises";
import net from "node:net";
import type { ClientConfigPayload, CommandArg, CommandChoice, CommandForm, CommandInput, CommandInputValue, DirectoryDefinition, DirectoryFiles, DirectoryScripts, ScriptSettings, AdtDefinition, DirectoryDefaultAction, DirectoryShortcut, DnsDefinition, DnsRecord, HostAccess, IntegrationDefinition, LoadBalancerCertificate, PassthroughRule, ProjectDefinition, ProjectRestore, RuntimeConfig } from "@appsys/devtool-shared";
import { logger } from "@appsys/devtool-shared";
import { resolveCacheFolder } from "@appsys/devtool-config";
import { type CommandAnswer, type CommandAutomation, findInvalidValueBlocks } from "./command-automation.js";
import { listScripts } from "./scripts.js";
import { isObject, toCommandArgsArray, toRecord, toStringArray, toStringRecord } from "./utils.js";

const SLUG_REGEXP = /^[a-zA-Z0-9\-\/_.]+$/i;
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
  };
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

  constructor(config: Record<string, unknown>) {
    this.initialConfig = config;
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
    };
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
   * Reads the settings of the devtool itself, `adt`: its host, interface, cache, shell, ports and access.
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

      this.loadBalancers[domain] = {
        crt: options.crt as string,
        key: options.key as string,
      };

      logger.info("Config", "LoadBalancer", domain);
    }
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
    const projectDefinition: ProjectDefinition = {
      slug: projectSlug,
      name: projectName,
      description: typeof project.description === "string" ? project.description : null,
      path: projectPath,
      directories: {},
      notifications: project.notifications === false ? false : this.adt.notifications,
      missing: false,
      restore: this.readRestore(`${slug}.restore`, project.restore),
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
        await this.reconfigureProjectDirectory(`${slug}.directories[${directorySlug}]`, projectDefinition, directorySlug, directory);
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
   */
  private async reconfigureProjectDirectory(
    slug: string,
    projectDefinition: ProjectDefinition,
    directorySlug: string,
    directory: Record<string, unknown>,
  ): Promise<void> {
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
        meta: extra.meta,
      };
    }

    directoryDefinition.scripts = await this.readScripts(`${slug}.scripts`, directoryPath, directory.scripts);
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
    directoryDefinition.files = this.readFiles(`${slug}.files`, directoryDefinition, directory.files);
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
   * `{ path, prompt, form, only, scripts }`.
   * @param slug Names the setting in warnings.
   * @param directoryPath Absolute path of the directory, relative folders are resolved from it.
   * @param value The raw setting.
   * @returns The existing folders.
   */
  private async readScripts(slug: string, directoryPath: string, value: unknown): Promise<DirectoryScripts[]> {
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

      const scripts: Record<string, ScriptSettings> = {};
      for (const [name, settingsRaw] of Object.entries(toRecord(folder.scripts))) {
        const settings = toRecord(settingsRaw);
        scripts[name] = {
          prompt: typeof settings.prompt === "boolean" ? settings.prompt : null,
          args: settings.args === undefined ? null : this.readCommandArgs(`${slug}[${index}].scripts[${name}].args`, settings.args),
          form: this.readForm(`${slug}[${index}].scripts[${name}].form`, settings.form),
        };
      }
      const only = folder.only === undefined ? null : toStringArray(folder.only);
      if (folder.only !== undefined && !only) {
        this.addWarning(`${slug}[${index}].only`, "must be an array of glob patterns");
      }
      folders.push({ path: folderPath, prompt: folder.prompt === true, form: this.readForm(`${slug}[${index}].form`, folder.form) ?? "inline", only, scripts });
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
   * @returns The folders by slug.
   */
  private readFiles(slug: string, directory: DirectoryDefinition, value: unknown): Record<string, DirectoryFiles> {
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
