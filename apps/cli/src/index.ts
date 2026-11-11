#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { checkbox, confirm, select } from "@inquirer/prompts";
import { Command } from "commander";
import {
  CdnClient,
  type CdnOptions,
  CdnSignInRequiredError,
  Environment,
  type EnvironmentItem,
  type EnvironmentOptions,
  type EnvironmentSelection,
  listTables,
  localPathOf,
  login,
  logout,
  openInBrowser,
  overwritesLocalData,
  parseTargets,
  readCdnOptions,
  readEnvironmentOptions,
  redisDatabaseName,
  SHARED_CONFIG_PATH,
  type TransferResult,
} from "@appsys/devtool-cdn";
import { loadMergedConfig, resolveDefaultConfigPaths } from "@appsys/devtool-config";
import runProxy from "@appsys/devtool-proxy";
import runServer, { relaunchUnderApp } from "@appsys/devtool-server";
import { logger, type LogLevel } from "@appsys/devtool-shared";
import pkg from "../package.json" with { type: "json" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_UI_PATH = path.resolve(__dirname, "../../ui/dist");
const INSTALLATION_CONFIG_PATHS = resolveDefaultConfigPaths(path.resolve(__dirname, ".."));

/**
 * Reads the CDN options of the configuration of the devtool installation.
 * @returns The options.
 */
async function requireConfiguredCdn(): Promise<CdnOptions> {
  const options = readCdnOptions((await loadMergedConfig(INSTALLATION_CONFIG_PATHS)).config.cdn);
  if (!options) {
    throw new Error("no `cdn` section (url, authelia.issuer, authelia.clientId) in the devtool configuration");
  }

  return options;
}

/**
 * Signs the developer in to the CDN in the browser.
 * @param options The CDN options.
 */
async function signIn(options: CdnOptions): Promise<void> {
  await login(options, (url) => {
    logger.info("CLI", "Login", `Sign in on ${url}`);
    openInBrowser(url);
  });
  logger.info("CLI", "Login", "Signed in");
}

const SHARED_CONFIG_SELECTION: EnvironmentSelection = { item: { kind: "file", path: SHARED_CONFIG_PATH }, tables: null };

/**
 * Loads the environment declared by the shared configuration, downloading that configuration first when it is not
 * there yet.
 * @param client The client of the devtool files of the CDN.
 * @param configPaths Paths of the configuration files.
 * @returns The environment.
 */
async function loadEnvironment(client: CdnClient, configPaths: string[]): Promise<EnvironmentOptions> {
  const read = async (): Promise<EnvironmentOptions | null> => readEnvironmentOptions((await loadMergedConfig(configPaths)).config.environment);
  const options = (await read()) ?? ((await new Environment(client, { items: [], s3: null }).pull(SHARED_CONFIG_SELECTION)).done ? await read() : null);
  if (!options) {
    throw new Error(`no \`environment\` section in ${localPathOf(SHARED_CONFIG_PATH)}`);
  }

  return options;
}

/**
 * Describes an item of the environment.
 * @param item The item.
 * @returns Its path and what it holds.
 */
function describeItem(item: EnvironmentItem): string {
  switch (item.kind) {
    case "database":
      return `${item.path} (${item.engine} database of container ${item.container})`;
    case "bucket":
      return `${item.path} (bucket ${item.bucket})`;
    case "redis":
      return `${item.path} (Redis ${redisDatabaseName(item.url)})`;
    default:
      return `${item.path} (file)`;
  }
}

/**
 * Names a selection the way targets are written.
 * @param selection The selection.
 * @returns The target.
 */
function targetOf(selection: EnvironmentSelection): string {
  return selection.tables ? `${selection.item.path}:${selection.tables.join(",")}` : selection.item.path;
}

/**
 * Asks which items, and which tables of the databases or key groups of the Redis databases, to transfer.
 * @param options The environment.
 * @param verb What is done with them.
 * @returns The selections.
 */
async function chooseSelections(options: EnvironmentOptions, verb: string): Promise<EnvironmentSelection[]> {
  const items = await checkbox({
    message: `Items to ${verb}`,
    choices: options.items.map((item) => ({ name: describeItem(item), value: item })),
    required: true,
    pageSize: 15,
  });

  const selections: EnvironmentSelection[] = [];
  for (const item of items) {
    if (item.kind !== "database" && item.kind !== "redis") {
      selections.push({ item, tables: null });
      continue;
    }

    const parts = item.kind === "redis" ? "key groups" : "tables";
    const whole = await select({
      message: `${item.path}: whole database or some ${parts}?`,
      choices: [
        { name: "Whole database", value: true },
        { name: `Some ${parts}`, value: false },
      ],
    });
    const tables = whole
      ? null
      : await checkbox({ message: `The ${parts} of ${item.path}`, choices: (await listTables(item)).map((table) => ({ name: table, value: table })), required: true, pageSize: 20 });
    selections.push({ item, tables });
  }

  return selections;
}

/**
 * Makes sure the developer accepts losing the local data a pull replaces.
 * @param selections The selections to pull.
 * @param yes Whether the developer already accepted.
 * @returns False when the developer declines.
 */
async function acceptOverwrite(selections: EnvironmentSelection[], yes: boolean): Promise<boolean> {
  const overwritten = selections.filter(overwritesLocalData).map(targetOf);
  if (overwritten.length === 0 || yes) {
    return true;
  }

  if (!process.stdin.isTTY) {
    throw new Error(`pulling ${overwritten.join(", ")} replaces local data: pass --yes`);
  }

  return confirm({ message: `Replace the local data of ${overwritten.join(", ")}?`, default: false });
}

/**
 * Transfers selections one by one, reporting each, and fails at the end when one of them failed.
 * @param selections The selections.
 * @param run Transfers one selection.
 */
async function transfer(selections: EnvironmentSelection[], run: (selection: EnvironmentSelection) => Promise<TransferResult>): Promise<void> {
  let failures = 0;
  for (const selection of selections) {
    try {
      const result = await run(selection);
      if (result.done) {
        logger.info("CLI", "Env", `${targetOf(selection)}: ${result.detail}`);
      } else {
        logger.warn("CLI", "Env", `${targetOf(selection)}: ${result.detail}`);
      }
    } catch (error) {
      if (error instanceof CdnSignInRequiredError) {
        throw error;
      }

      failures += 1;
      logger.error("CLI", "Env", `${targetOf(selection)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} of ${selections.length} items failed`);
  }
}

/**
 * Pulls or pushes items of the environment, chosen by targets or interactively.
 * @param direction Whether the CDN copy replaces the local one, or the reverse.
 * @param targets The targets, every item when empty.
 * @param flags Whether to choose interactively and whether local data may be replaced without asking.
 */
async function syncEnvironment(direction: "pull" | "push", targets: string[], flags: { interactive?: boolean; yes?: boolean }): Promise<void> {
  const client = new CdnClient(await requireConfiguredCdn());
  const options = await loadEnvironment(client, INSTALLATION_CONFIG_PATHS);
  const selections = flags.interactive ? await chooseSelections(options, direction) : parseTargets(options, targets);
  const environment = new Environment(client, options);
  if (direction === "push") {
    await transfer(selections, (selection) => environment.push(selection));
    return;
  }

  if (!(await acceptOverwrite(selections, flags.yes === true))) {
    logger.warn("CLI", "Env", "Nothing pulled");
    return;
  }

  await transfer(selections, (selection) => environment.pull(selection));
}

function parsePort(input: string, label: string): number {
  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${input}`);
  }
  return parsed;
}

function parseOptionalPort(input: string | undefined, label: string): number | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  return parsePort(input, label);
}

/**
 * Declares the commands of the devtool CLI and runs the one invoked.
 * @returns Resolves once the command ends.
 */
async function main(): Promise<void> {
  const program = new Command();

  program.name("devtool").version(pkg.version);

  program
    .command("server [configurations...]")
    .description("Run Devtool server")
    .option("-s, --ssl <domain>", "enable SSL for the domain given")
    .option("-g, --server-port <port>", "server port")
    .option("-l, --load-balancer-port <port>", "load balancer port")
    .option("--ui-path <path>", "path to static UI files", DEFAULT_UI_PATH)
    .option("--log-level <level>", "set log level (error|warn|info|debug)", "info")
    .action(async (configurations: string[], options: Record<string, string | undefined>) => {
      if (await relaunchUnderApp()) {
        return;
      }
      logger.setLevel((options.logLevel ?? "info") as LogLevel);

      const invocationCwd = process.env.INIT_CWD && process.env.INIT_CWD.length ? process.env.INIT_CWD : process.cwd();
      const configPaths = configurations.length
        ? configurations.map((configuration) => (path.isAbsolute(configuration) ? configuration : path.resolve(invocationCwd, configuration)))
        : resolveDefaultConfigPaths();

      await runServer({
        serverPort: parseOptionalPort(options.serverPort, "server port"),
        loadBalancerPort: parseOptionalPort(options.loadBalancerPort, "load balancer port"),
        ssl: options.ssl ?? null,
        uiPath: options.uiPath ?? null,
        configPaths,
      });
    });

  program
    .command("proxy")
    .description("Create a TCP proxy to Devtool load-balancer")
    .option("-l, --load-balancer-port <port>", "Devtool load-balancer port", "6731")
    .option("-p, --proxy-port <port>", "proxy port", "443")
    .option("--log-level <level>", "set log level (error|warn|info|debug)", "info")
    .action((options: Record<string, string | undefined>) => {
      logger.setLevel((options.logLevel ?? "info") as LogLevel);
      runProxy({
        adtSecurePort: parsePort(options.loadBalancerPort ?? "6731", "load balancer port"),
        proxyPort: parsePort(options.proxyPort ?? "443", "proxy port"),
      });
    });

  program
    .command("login")
    .description("Sign in to the CDN with Authelia")
    .action(async () => {
      await signIn(await requireConfiguredCdn());
    });

  program
    .command("logout")
    .description("Forget the CDN session")
    .action(async () => {
      await logout();
      logger.info("CLI", "Logout", "Signed out");
    });

  const cdn = program.command("cdn").description("Devtool files of the CDN (database dumps, configurations)");

  cdn
    .command("pull <path> [destination]")
    .description("Download a file; `-` as destination writes it to the standard output")
    .action(async (filePath: string, destination: string | undefined) => {
      const content = await new CdnClient(await requireConfiguredCdn()).download(filePath);
      if (!content) {
        throw new Error(`no such file: ${filePath}`);
      }

      if (destination === "-") {
        await pipeline(content, process.stdout);
        return;
      }

      const target = path.resolve(destination ?? path.basename(filePath));
      const partial = `${target}.part`;
      try {
        await pipeline(content, createWriteStream(partial, { mode: 0o600 }));
        await fs.rename(partial, target);
      } finally {
        await fs.rm(partial, { force: true });
      }
      logger.info("CLI", "Pull", `${filePath} -> ${target}`);
    });

  cdn
    .command("push <path> <file>")
    .description("Upload a file, replacing the stored one (write group only)")
    .option("-t, --type <mediaType>", "media type served with the file", "application/octet-stream")
    .action(async (filePath: string, file: string, options: { type: string }) => {
      await new CdnClient(await requireConfiguredCdn()).upload(filePath, path.resolve(file), options.type);
      logger.info("CLI", "Push", `${file} -> ${filePath}`);
    });

  cdn
    .command("rm <path>")
    .description("Delete a file (write group only)")
    .action(async (filePath: string) => {
      await new CdnClient(await requireConfiguredCdn()).remove(filePath);
      logger.info("CLI", "Remove", filePath);
    });

  const env = program
    .command("env")
    .description(`Development environment in ${localPathOf("")}, mirrored on the CDN: configurations, databases, buckets, Redis databases`)
    .addHelpText("after", "\nTargets: <path> for an item, <path>:<table>,<table> for tables of a database, <path>:<group>,<group> for key groups of a Redis database (such as account/redis.gz:session:*); every item without target.");

  env
    .command("pull [targets...]")
    .description("Replace local items, and the local data they hold, by the CDN copies")
    .option("-i, --interactive", "choose items, tables and key groups")
    .option("-y, --yes", "replace local data without asking")
    .action(async (targets: string[], flags: { interactive?: boolean; yes?: boolean }) => {
      await syncEnvironment("pull", targets, flags);
    });

  env
    .command("push [targets...]")
    .description("Dump the local data of the items and send them to the CDN (write group only)")
    .option("-i, --interactive", "choose items, tables and key groups")
    .action(async (targets: string[], flags: { interactive?: boolean }) => {
      await syncEnvironment("push", targets, flags);
    });

  await program.parseAsync();
}

void main().catch((error) => {
  logger.error("CLI", "Main", error instanceof Error ? error.message : "Unknown CLI error");
  process.exit(1);
});
