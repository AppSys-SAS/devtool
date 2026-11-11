import path from "node:path";
import fs from "node:fs/promises";
import net from "node:net";
import type { ClientConfigPayload, DirectoryDefinition, DirectoryFiles, DirectoryScripts, ScriptArgument, ScriptSettings, AdtDefinition, DnsDefinition, DnsRecord, HostAccess, LoadBalancerCertificate, PassthroughRule, ProjectDefinition, ProjectRestore, RuntimeConfig } from "@appsys/devtool-shared";
import { logger } from "@appsys/devtool-shared";
import { type CommandAnswer, type CommandAutomation, findInvalidValueBlocks } from "./command-automation.js";
import { isObject, toCommandArgsArray, toIntegerArray, toRecord, toStringArray, toStringRecord } from "./utils.js";

const SLUG_REGEXP = /^[a-zA-Z0-9\-\/_.]+$/i;
const HOST_PATTERN_REGEXP = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/**
 * Gives the settings of the devtool before the configuration is read.
 * @returns The default settings.
 */
function defaultAdt(): AdtDefinition {
  return {
    host: null,
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

  constructor(config: Record<string, unknown>) {
    this.initialConfig = config;
    this.adt = defaultAdt();
    this.loadBalancers = {};
    this.passthrough = [];
    this.dns = null;
    this.projects = {};
    this.automations = {};
    this.warnings = [];
  }

  get runtimeConfig(): RuntimeConfig {
    return {
      adt: this.adt,
      loadBalancers: this.loadBalancers,
      passthrough: this.passthrough,
      dns: this.dns,
      projects: this.projects,
      warnings: this.warnings,
    };
  }

  getForClient(version: string): ClientConfigPayload {
    return {
      version,
      warnings: this.warnings,
      loadBalancers: Object.keys(this.loadBalancers),
      projects: this.projects,
    };
  }

  async reconfigure(): Promise<void> {
    this.adt = defaultAdt();
    this.loadBalancers = {};
    this.passthrough = [];
    this.dns = null;
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

    try {
      await this.reconfigureProjects();
    } catch (error) {
      this.addWarning("projects", error instanceof Error ? error.message : "Unknown projects error");
    }
  }

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

    if (!(await this.checkDirectory(`${slug}.path`, directoryPath))) {
      return;
    }

    const args = directory.args === undefined || directory.args === null ? null : toCommandArgsArray(directory.args);
    if (directory.args !== undefined && directory.args !== null && !args) {
      this.addWarning(`${slug}.args`, "must be an array of strings or numbers");
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
      defaultFiles: null,
      notifications: directory.notifications === false ? false : projectDefinition.notifications,
      env: {},
      shell: this.adt.shell,
      killSignal: null,
      meta: directory.meta,
    };

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
      const hosts = toStringArray(lb.hosts);
      const parsedPorts = toIntegerArray(lb.ports);
      if ("ports" in lb && parsedPorts === null) {
        this.addWarning(`${slug}.loadBalancer[${lbSlug}].ports`, "must be an array of positive integers");
        continue;
      }
      const ports = parsedPorts ?? [];
      const urls: string[] = [];

      if (!hosts?.length) {
        this.addWarning(`${slug}.loadBalancer[${lbSlug}].hosts`, "not defined or empty");
        continue;
      }

      if ("url" in lb) {
        if (typeof lb.url !== "string") {
          this.addWarning(`${slug}.loadBalancer[${lbSlug}].url`, "is not a string");
          continue;
        }
        urls.push(lb.url);
      }

      if ("urls" in lb) {
        const lbUrls = toStringArray(lb.urls);
        if (!lbUrls) {
          this.addWarning(`${slug}.loadBalancer[${lbSlug}].urls`, "must be an array of strings");
          continue;
        }
        urls.push(...lbUrls);
      }

      const validatedUrls: string[] = [];
      for (const rawUrl of urls) {
        const urlValue = rawUrl.trim();
        if (!urlValue.length) {
          continue;
        }

        try {
          const parsedUrl = new URL(urlValue);
          if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
            this.addWarning(`${slug}.loadBalancer[${lbSlug}].url`, "must use http:// or https://");
            continue;
          }
          validatedUrls.push(parsedUrl.toString());
        } catch {
          this.addWarning(`${slug}.loadBalancer[${lbSlug}].url`, `invalid URL: ${urlValue}`);
          continue;
        }
      }

      const tls = lb.tls === true;
      if ("tls" in lb && lb.tls !== true && lb.tls !== false) {
        this.addWarning(`${slug}.loadBalancer[${lbSlug}].tls`, "is not a boolean");
        continue;
      }

      if (lb.path && !this.checkString(`${slug}.loadBalancer[${lbSlug}].path`, lb.path)) {
        continue;
      }
      if (lb.prefix && !this.checkString(`${slug}.loadBalancer[${lbSlug}].prefix`, lb.prefix)) {
        continue;
      }
      if (lb.pathNot && !this.checkString(`${slug}.loadBalancer[${lbSlug}].pathNot`, lb.pathNot)) {
        continue;
      }

      const preserveHost = lb.preserveHost === true;
      if ("preserveHost" in lb && lb.preserveHost !== true && lb.preserveHost !== false) {
        this.addWarning(`${slug}.loadBalancer[${lbSlug}].preserveHost`, "is not a boolean");
        continue;
      }

      directoryDefinition.loadBalancer[lbSlug] = {
        slug: lbSlug,
        hosts,
        ports,
        urls: validatedUrls,
        tls,
        path: typeof lb.path === "string" ? lb.path : null,
        prefix: typeof lb.prefix === "string" ? lb.prefix : null,
        pathNot: typeof lb.pathNot === "string" ? lb.pathNot : null,
        preserveHost,
        access: this.readAccess(`${slug}.loadBalancer[${lbSlug}].access`, lb.access),
      };
    }

    const extras = toRecord(directory.extras);
    for (const [extraSlug, extraRaw] of Object.entries(extras)) {
      const extra = toRecord(extraRaw);
      const extraArgs = toCommandArgsArray(extra.args);
      if (!extraArgs) {
        this.addWarning(`${slug}.extras[${extraSlug}].args`, "must be an array of strings or numbers");
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
        automated: automation !== null,
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
        meta: extra.meta,
      };
    }

    directoryDefinition.scripts = await this.readScripts(`${slug}.scripts`, directoryPath, directory.scripts);
    directoryDefinition.files = this.readFiles(`${slug}.files`, directoryDefinition, directory.files);
    directoryDefinition.defaultFiles = this.readDefaultFiles(`${slug}.files.default`, directoryDefinition.files, toRecord(directory.files).default);

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
   * Reads what the server does on its own around a command: `unless`, a command whose success skips
   * it, `answers`, `{ match, value }` typed when the output asks `match`, and the value blocks of its
   * arguments, environment and answers, `{{ op://… }}` read from `opAccount` or `{{ $(…) }}`.
   * @param slug Names the command in warnings.
   * @param command The raw command.
   * @param args The arguments of the command.
   * @param env The environment of the command.
   * @returns The automation, null when the command declares none.
   */
  private readAutomation(slug: string, command: Record<string, unknown>, args: string[], env: Record<string, string>): CommandAutomation | null {
    const values = [
      ...args.map((arg, index) => ({ slug: `${slug}.args[${index}]`, text: arg })),
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
   * `{ path, prompt, only, scripts }`.
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
          args: settings.args === undefined ? null : this.readScriptArguments(`${slug}[${index}].scripts[${name}].args`, settings.args),
        };
      }
      const only = folder.only === undefined ? null : toStringArray(folder.only);
      if (folder.only !== undefined && !only) {
        this.addWarning(`${slug}[${index}].only`, "must be an array of glob patterns");
      }
      folders.push({ path: folderPath, prompt: folder.prompt === true, only, scripts });
    }
    return folders;
  }

  /**
   * Reads the arguments declared for a script, each `{ name, choices, optional }`, `{ name, flag: true }`
   * or `{ name, text: true }`; invalid ones are left out.
   * @param slug Names the setting in warnings.
   * @param value The raw setting.
   * @returns The arguments, in order.
   */
  private readScriptArguments(slug: string, value: unknown): ScriptArgument[] {
    if (!Array.isArray(value)) {
      this.addWarning(slug, "must be an array");
      return [];
    }

    const args: ScriptArgument[] = [];
    for (const [index, raw] of value.entries()) {
      const arg = toRecord(raw);
      const choices = toStringArray(arg.choices);
      if (!this.checkString(`${slug}[${index}].name`, arg.name)) {
        continue;
      }

      if (choices?.length) {
        args.push({ name: arg.name as string, kind: "choice", choices, optional: arg.optional === true });
      } else if (arg.flag === true || arg.text === true) {
        args.push({ name: arg.name as string, kind: arg.flag === true ? "flag" : "text", choices: [], optional: true });
      } else {
        this.addWarning(`${slug}[${index}]`, "needs choices, flag: true or text: true");
      }
    }
    return args;
  }

  /**
   * Reads the folder of files a directory opens by default, given as `{ alias: <slug> }`.
   * @param slug Names the setting in warnings.
   * @param files The folders of files of the directory.
   * @param value The raw setting.
   * @returns The slug of the folder, null when there is none.
   */
  private readDefaultFiles(slug: string, files: Record<string, DirectoryFiles>, value: unknown): string | null {
    if (value === undefined) {
      return null;
    }

    const alias = toRecord(value).alias;
    if (typeof alias !== "string" || !(alias in files)) {
      this.addWarning(slug, "must be { alias: <slug of a folder of files> }");
      return null;
    }
    return alias;
  }

  /**
   * Reads the folders of editable files a directory declares, which may not exist yet; `default`
   * names the one opened by default.
   * @param slug Names the setting in warnings.
   * @param directory The directory, its extras already read.
   * @param value The raw setting.
   * @returns The folders by slug.
   */
  private readFiles(slug: string, directory: DirectoryDefinition, value: unknown): Record<string, DirectoryFiles> {
    const files: Record<string, DirectoryFiles> = {};
    for (const [filesSlug, filesRaw] of Object.entries(toRecord(value))) {
      if (filesSlug === "default") {
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
