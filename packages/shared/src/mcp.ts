import type { McpAction, McpLevel, McpRules } from "./types.js";

/** Every action of an agent, in the order they are shown. */
export const MCP_ACTIONS: readonly McpAction[] = ["read", "run", "input", "control", "write"];

/** Every level of an action, from the most to the least permissive. */
export const MCP_LEVELS: readonly McpLevel[] = ["allow", "keys", "ask", "deny"];

/** The actions on files, the only ones accepting the `keys` level. */
const KEYS_ACTIONS: readonly McpAction[] = ["read", "write"];

/**
 * Gives the rules of everything when the configuration declares none: seeing is allowed, anything
 * else is asked.
 * @param from The setting the rules come from.
 * @returns The rules.
 */
export function defaultMcpRules(from: string): McpRules {
  return {
    read: { level: "allow", from },
    run: { level: "ask", from },
    input: { level: "ask", from },
    control: { level: "ask", from },
    write: { level: "ask", from },
  };
}

/**
 * Tells whether a value is a level of an action.
 * @param value The value.
 * @returns True for a level.
 */
export function isMcpLevel(value: unknown): value is McpLevel {
  return typeof value === "string" && (MCP_LEVELS as readonly string[]).includes(value);
}

/**
 * Gives the levels an action accepts: `keys` for reading and writing files only.
 * @param action The action.
 * @returns The levels, from the most to the least permissive.
 */
export function mcpLevelsFor(action: McpAction): McpLevel[] {
  return MCP_LEVELS.filter((level) => level !== "keys" || KEYS_ACTIONS.includes(action));
}

/**
 * Reads the levels an `mcp` setting declares: a level for every action it accepts, or levels by action.
 * @param value The raw setting, undefined when it is not declared.
 * @returns The levels by action, and the problems of the setting.
 */
export function mcpLevelsOf(value: unknown): { levels: Partial<Record<McpAction, McpLevel>>; problems: string[] } {
  if (value === undefined) {
    return { levels: {}, problems: [] };
  }
  if (isMcpLevel(value)) {
    return { levels: Object.fromEntries(MCP_ACTIONS.filter((action) => mcpLevelsFor(action).includes(value)).map((action) => [action, value])), problems: [] };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { levels: {}, problems: [`must be one of ${MCP_LEVELS.join(", ")}, or levels by action (${MCP_ACTIONS.join(", ")})`] };
  }

  const levels: Partial<Record<McpAction, McpLevel>> = {};
  const problems: string[] = [];
  for (const [action, level] of Object.entries(value)) {
    if (!(MCP_ACTIONS as readonly string[]).includes(action)) {
      problems.push(`${action} is not an action (${MCP_ACTIONS.join(", ")})`);
    } else if (!isMcpLevel(level) || !mcpLevelsFor(action as McpAction).includes(level)) {
      problems.push(`${action} must be one of ${mcpLevelsFor(action as McpAction).join(", ")}`);
    } else {
      levels[action as McpAction] = level;
    }
  }
  return { levels, problems };
}

/**
 * Reads the `mcp` setting of something of the configuration over the rules it inherits: a level for
 * every action (`keys` for reading and writing files only), or levels by action.
 * @param value The raw setting, undefined when it is not declared.
 * @param inherited The rules of what holds it.
 * @param from Names the setting in the rules it declares.
 * @returns The rules, and the problems of the setting.
 */
export function readMcpRules(value: unknown, inherited: McpRules, from: string): { rules: McpRules; problems: string[] } {
  const { levels, problems } = mcpLevelsOf(value);
  const rules: McpRules = { ...inherited };
  for (const [action, level] of Object.entries(levels)) {
    rules[action as McpAction] = { level, from };
  }
  return { rules, problems };
}
