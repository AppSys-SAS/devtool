import type { DirectoryExtra, McpAnswer, McpDecision, McpLevel, ProjectDefinition } from "@appsys/devtool-shared";

/** How each decision of a call is shown. */
export const DECISIONS: Record<McpDecision, { label: string; class: string }> = {
  auto: { label: "Auto", class: "border-transparent bg-muted text-muted-foreground" },
  once: { label: "Once", class: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  session: { label: "Session", class: "border-transparent bg-indigo-500/15 text-indigo-700 dark:text-indigo-300" },
  always: { label: "Always", class: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  denied: { label: "Denied", class: "border-transparent bg-destructive/15 text-destructive" },
  config: { label: "Config", class: "border-destructive/40 text-destructive" },
  timeout: { label: "Timeout", class: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  noUi: { label: "No UI", class: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300" },
};

/** How each level of an action is shown. */
export const LEVELS: Record<McpLevel, string> = {
  allow: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  keys: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300",
  ask: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
  deny: "border-transparent bg-destructive/15 text-destructive",
};

/** The labels of the answers to a request. */
export const ANSWERS: Record<McpAnswer, string> = {
  deny: "Deny",
  once: "Allow once",
  session: "This session",
  always: "Always",
};

/**
 * Finds a command of the configuration from its identifier for agents.
 * @param projects The sections of the configuration.
 * @param id `<section>/<project>/<slug>`, the slug of a script being its path.
 * @returns The command, null when it is unknown.
 */
export function findMcpCommand(projects: Record<string, ProjectDefinition> | null, id: string): DirectoryExtra | null {
  const [section, project, ...slug] = id.split("/");
  return projects?.[section]?.directories[project]?.extras[slug.join("/")] ?? null;
}

/**
 * Gives the command declaring the MCP server of the devtool to Claude Code.
 * @param port The port of the devtool server.
 * @returns The command line.
 */
export function mcpAddCommand(port: number): string {
  return `claude mcp add --transport http devtool http://127.0.0.1:${port}/mcp`;
}
