#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { resolveDefaultConfigPaths } from "@appsys/devtool-config";
import runProxy from "@appsys/devtool-proxy";
import runServer from "@appsys/devtool-server";
import { logger, type LogLevel } from "@appsys/devtool-shared";
import pkg from "../package.json" with { type: "json" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_UI_PATH = path.resolve(__dirname, "../../ui/dist");

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

  await program.parseAsync();
}

void main().catch((error) => {
  logger.error("CLI", "Main", error instanceof Error ? error.message : "Unknown CLI error");
  process.exit(1);
});
