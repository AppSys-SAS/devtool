import path from "node:path";
import fs from "node:fs/promises";
import type { ClientConfigPayload, DirectoryDefinition, GceDefinition, LoadBalancerCertificate, ProjectDefinition, RuntimeConfig } from "@appsys/devtool-shared";
import { logger } from "@appsys/devtool-shared";
import { isObject, toIntegerArray, toRecord, toStringArray, toStringRecord } from "./utils.js";

const SLUG_REGEXP = /^[a-zA-Z0-9\-\/_.]+$/i;

export class DevtoolConfigure {
  private readonly initialConfig: Record<string, unknown>;

  public gce: GceDefinition;

  public loadBalancers: Record<string, LoadBalancerCertificate>;

  public projects: Record<string, ProjectDefinition>;

  public warnings: string[];

  constructor(config: Record<string, unknown>) {
    this.initialConfig = config;
    this.gce = {
      host: null,
      ports: {
        server: 6730,
        loadBalancer: 6731,
      },
      secure: false,
      notifications: true,
      hosts: [],
    };
    this.loadBalancers = {};
    this.projects = {};
    this.warnings = [];
  }

  get runtimeConfig(): RuntimeConfig {
    return {
      gce: this.gce,
      loadBalancers: this.loadBalancers,
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
    this.gce = {
      host: null,
      ports: {
        server: 6730,
        loadBalancer: 6731,
      },
      secure: false,
      notifications: true,
      hosts: [],
    };
    this.loadBalancers = {};
    this.projects = {};
    this.warnings = [];

    try {
      await this.reconfigureGce();
    } catch (error) {
      this.addWarning("gce", error instanceof Error ? error.message : "Unknown gce error");
    }

    try {
      await this.reconfigureLoadBalancers();
    } catch (error) {
      this.addWarning("loadBalancers", error instanceof Error ? error.message : "Unknown load balancer error");
    }

    try {
      await this.reconfigureProjects();
    } catch (error) {
      this.addWarning("projects", error instanceof Error ? error.message : "Unknown projects error");
    }
  }

  private async reconfigureGce(): Promise<void> {
    const gce = toRecord(this.initialConfig.gce);
    if (Object.keys(gce).length === 0) {
      return;
    }

    if (typeof gce.host === "string") {
      this.gce.host = gce.host;
    }

    if (typeof gce.uiPath === "string") {
      this.gce.uiPath = gce.uiPath;
    }

    if (gce.secure === true || gce.secure === false) {
      if (gce.secure && !this.gce.host) {
        this.addWarning("gce.secure", "You have to define gce.host if you want secure connections.");
      } else {
        this.gce.secure = gce.secure;
      }
    }

    if (isObject(gce.ports)) {
      if (Number.isInteger(gce.ports.server) && (gce.ports.server as number) > 0) {
        this.gce.ports.server = gce.ports.server as number;
      }
      if (Number.isInteger(gce.ports.loadBalancer) && (gce.ports.loadBalancer as number) > 0) {
        this.gce.ports.loadBalancer = gce.ports.loadBalancer as number;
      }
    }

    if (gce.notifications === true || gce.notifications === false) {
      this.gce.notifications = gce.notifications;
    }

    const hosts = toStringArray(gce.hosts);
    if (hosts) {
      this.gce.hosts = hosts;
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
    if (!(await this.checkDirectory(`${slug}.path`, projectPath, true))) {
      return;
    }

    const directoriesRecord = toRecord(project.directories);
    if (!Object.keys(directoriesRecord).length) {
      this.addWarning(`${slug}.directories`, "is empty");
      return;
    }

    const projectDefinition: ProjectDefinition = {
      slug: projectSlug,
      name: projectName,
      description: typeof project.description === "string" ? project.description : null,
      path: projectPath,
      directories: {},
      notifications: project.notifications === false ? false : this.gce.notifications,
      meta: project.meta,
    };

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

    const args = toStringArray(directory.args);
    if (!args || !args.length) {
      this.addWarning(`${slug}.args`, "is empty");
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
      notifications: directory.notifications === false ? false : projectDefinition.notifications,
      env: {},
      meta: directory.meta,
    };

    if (directory.notifications === true || directory.notifications === false) {
      directoryDefinition.notifications = directory.notifications;
    }

    const env = toStringRecord(directory.env);
    if (env) {
      directoryDefinition.env = env;
    }

    const lbRecord = toRecord(directory.loadBalancer);
    for (const [lbSlug, lbRaw] of Object.entries(lbRecord)) {
      const lb = toRecord(lbRaw);
      const hosts = toStringArray(lb.hosts);
      const ports = toIntegerArray(lb.ports);

      if (!hosts?.length) {
        this.addWarning(`${slug}.loadBalancer[${lbSlug}].hosts`, "not defined or empty");
        continue;
      }
      if (!ports?.length) {
        this.addWarning(`${slug}.loadBalancer[${lbSlug}].ports`, "not defined or empty");
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

      directoryDefinition.loadBalancer[lbSlug] = {
        slug: lbSlug,
        hosts,
        ports,
        path: typeof lb.path === "string" ? lb.path : null,
        prefix: typeof lb.prefix === "string" ? lb.prefix : null,
        pathNot: typeof lb.pathNot === "string" ? lb.pathNot : null,
      };
    }

    const extras = toRecord(directory.extras);
    for (const [extraSlug, extraRaw] of Object.entries(extras)) {
      const extra = toRecord(extraRaw);
      const extraArgs = toStringArray(extra.args);
      if (!extraArgs?.length) {
        this.addWarning(`${slug}.extras[${extraSlug}].args`, "not defined or empty");
        continue;
      }

      const extraName = this.checkString(`${slug}.extras[${extraSlug}].name`, extra.name) ? (extra.name as string) : extraSlug;
      const extraEnv = toStringRecord(extra.env) ?? {};

      directoryDefinition.extras[extraSlug] = {
        slug: extraSlug,
        name: extraName,
        args: extraArgs,
        detached: extra.detached === true,
        notifications: extra.notifications === false ? false : directoryDefinition.notifications,
        env: extraEnv,
      };
    }

    projectDefinition.directories[directorySlug] = directoryDefinition;
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

  private addWarning(slug: string, message: string): false {
    logger.warn("Config", slug, message);
    this.warnings.push(`${slug}: ${message}.`);
    return false;
  }
}
