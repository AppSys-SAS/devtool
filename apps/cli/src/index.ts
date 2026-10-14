#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { CdnClient, type CdnOptions, hasSession, login, logout, openInBrowser, readCdnOptions } from "@appsys/devtool-cdn";
import { loadMergedConfig, resolveDefaultConfigPaths } from "@appsys/devtool-config";
import runProxy from "@appsys/devtool-proxy";
import runServer from "@appsys/devtool-server";
import { logger, type LogLevel } from "@appsys/devtool-shared";
import pkg from "../package.json" with { type: "json" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_UI_PATH = path.resolve(__dirname, "../../ui/dist");
const INSTALLATION_CONFIG_PATHS = resolveDefaultConfigPaths(path.resolve(__dirname, ".."));

/**
 * Reads the CDN options of the local configuration.
 * @param configPaths Paths of the configuration files.
 * @returns The options, or null when the configuration names no CDN.
 */
async function readConfiguredCdn(configPaths: string[]): Promise<CdnOptions | null> {
  return readCdnOptions((await loadMergedConfig(configPaths)).config.cdn);
}

/**
 * Reads the CDN options of the configuration of the devtool installation.
 * @returns The options.
 */
async function requireConfiguredCdn(): Promise<CdnOptions> {
  const options = await readConfiguredCdn(INSTALLATION_CONFIG_PATHS);
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
      logger.setLevel((options.logLevel ?? "info") as LogLevel);

      const invocationCwd = process.env.INIT_CWD && process.env.INIT_CWD.length ? process.env.INIT_CWD : process.cwd();
      const configPaths = configurations.length
        ? configurations.map((configuration) => (path.isAbsolute(configuration) ? configuration : path.resolve(invocationCwd, configuration)))
        : resolveDefaultConfigPaths();
      const cdn = await readConfiguredCdn(configPaths);
      if (cdn && !(await hasSession(cdn))) {
        await signIn(cdn).catch((error: unknown) => {
          logger.warn("CLI", "Login", `Not signed in, the configuration stored on the CDN is skipped: ${error instanceof Error ? error.message : String(error)}`);
        });
      }

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

  await program.parseAsync();
}

void main().catch((error) => {
  logger.error("CLI", "Main", error instanceof Error ? error.message : "Unknown CLI error");
  process.exit(1);
});
