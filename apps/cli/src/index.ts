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

async function main(): Promise<void> {
  const program = new Command();

  program.name("devtool").version(pkg.version);

  program
    .command("server [configurations...]")
    .description("Run Devtool server")
    .option("-s, --ssl <domain>", "enable SSL for the domain given")
    .option("-g, --server-port <port>", "server port", "6730")
    .option("-l, --load-balancer-port <port>", "load balancer port", "6731")
    .option("--ui-path <path>", "path to static UI files", DEFAULT_UI_PATH)
    .option("--log-level <level>", "set log level (error|warn|info|debug)", "info")
    .action(async (configurations: string[], options: Record<string, string>) => {
      logger.setLevel((options.logLevel ?? "info") as LogLevel);

      const configPaths = configurations.length ? configurations : resolveDefaultConfigPaths();
      await runServer({
        serverPort: parsePort(options.serverPort, "server port"),
        loadBalancerPort: parsePort(options.loadBalancerPort, "load balancer port"),
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
    .action((options: Record<string, string>) => {
      logger.setLevel((options.logLevel ?? "info") as LogLevel);
      runProxy({
        gceSecurePort: parsePort(options.loadBalancerPort, "load balancer port"),
        proxyPort: parsePort(options.proxyPort, "proxy port"),
      });
    });

  await program.parseAsync();
}

void main().catch((error) => {
  logger.error("CLI", "Main", error instanceof Error ? error.message : "Unknown CLI error");
  process.exit(1);
});
