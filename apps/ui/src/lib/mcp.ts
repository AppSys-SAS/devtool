import type { DirectoryExtra, McpAction, McpAnswer, McpDecision, McpLevel, ProjectDefinition } from "@appsys/devtool-shared";

/** How each decision of a call is shown. */
export const DECISIONS: Record<McpDecision, { label: string; class: string }> = {
  auto: { label: "Auto", class: "border-transparent bg-muted text-muted-foreground" },
  once: { label: "Once", class: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  session: { label: "Session", class: "border-transparent bg-indigo-500/15 text-indigo-700 dark:text-indigo-300" },
  always: { label: "Always", class: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  denied: { label: "Denied", class: "border-transparent bg-destructive/15 text-destructive" },
  config: { label: "Config", class: "border-transparent bg-rose-500/10 text-rose-700 dark:text-rose-300" },
  timeout: { label: "Timeout", class: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  noUi: { label: "No UI", class: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  cancelled: { label: "Cancelled", class: "border-transparent bg-muted text-muted-foreground" },
};

/** How each level of an action is shown. */
export const LEVELS: Record<McpLevel, string> = {
  allow: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  keys: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300",
  ask: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
  deny: "border-transparent bg-destructive/15 text-destructive",
};

/** The icons of the known agents, by a pattern of their name or display name, the first match winning. */
const AGENT_ICONS: [RegExp, string][] = [
  [/claude/, "simple-icons:claude"],
  [/gemini/, "simple-icons:googlegemini"],
  [/codex|openai|chatgpt/, "simple-icons:openai"],
  [/opencode/, "simple-icons:opencode"],
  [/cursor/, "simple-icons:cursor"],
  [/copilot|visual studio code|vscode/, "simple-icons:githubcopilot"],
  [/windsurf|codeium/, "simple-icons:windsurf"],
  [/\bzed\b/, "simple-icons:zedindustries"],
  [/cline/, "simple-icons:cline"],
  [/qwen/, "simple-icons:qwen"],
  [/mistral/, "simple-icons:mistralai"],
  [/jetbrains|junie/, "simple-icons:jetbrains"],
  [/warp/, "simple-icons:warp"],
  [/ollama/, "simple-icons:ollama"],
];

/**
 * Gives the icon of an agent from what it calls itself.
 * @param names Its name and display name.
 * @returns The icon of a known agent, else a generic one.
 */
export function agentIcon(...names: string[]): string {
  const text = names.join(" ").toLowerCase();
  return AGENT_ICONS.find(([pattern]) => pattern.test(text))?.[1] ?? "lucide:bot";
}

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

/** A level of an MCP setting changed from the Agents page, written once the edit is done. */
export interface McpLevelChange {
  path: string[];
  /** The action changed, null for a setting being a level itself. */
  action: McpAction | null;
  /** The new level, null to inherit it. */
  level: McpLevel | null;
  file: "local" | "declared";
}

/** Where the permissions changed from the Agents page are written, and the changes waiting, while it is in edit mode. */
export interface McpEditMode {
  /** The personal override, or the file declaring each setting. */
  file: "local" | "declared";
  /** The personal override, null when the server loads none. */
  localFile: string | null;
  /** The changes waiting, by {@link changeKey}. */
  staged: ReadonlyMap<string, McpLevelChange>;
  /**
   * Keeps a change until the edit is done, replacing the one of the same setting and action.
   * @param change The change.
   */
  stage(change: McpLevelChange): void;
}

/**
 * Names the setting and action a change applies to.
 * @param path The keys leading to the setting.
 * @param action The action, null for a setting being a level itself.
 * @returns The key.
 */
export function changeKey(path: string[], action: McpAction | null): string {
  return `${path.join("/")}#${action ?? ""}`;
}

/**
 * Shortens the path of a configuration file to its last folders.
 * @param file The absolute path.
 * @returns The file with its two parent folders.
 */
export function shortPath(file: string): string {
  return file.split("/").slice(-3).join("/");
}

/**
 * Gives the command declaring the MCP server of the devtool to Claude Code.
 * @param port The port of the devtool server.
 * @returns The command line.
 */
export function mcpAddCommand(port: number): string {
  return `claude mcp add --transport http devtool http://127.0.0.1:${port}/mcp`;
}
