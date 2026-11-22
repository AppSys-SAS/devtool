import { configFormatOf } from "@appsys/devtool-cdn";
import { environmentRules, type McpDetail, type McpRules } from "@appsys/devtool-shared";
import { z } from "zod";
import { McpRefusal } from "./approvals.js";
import type { McpFileSpace, McpHost } from "./host.js";
import { defineTool, McpToolError, type McpCall, type McpTool } from "./tool.js";

/** A space of files agents may see, with its rules. */
interface AgentFileSpace {
  id: string;
  name: string;
  /** The rules of the space as a whole. */
  rules: McpRules;
  /**
   * Gives the rules of a file of the space.
   * @param filePath The path of the file in the space.
   * @returns Its rules.
   */
  rulesOf(filePath: string): McpRules;
  space: McpFileSpace;
}

/**
 * Lists the spaces of files agents may see: the configs of the environment, each file following its
 * item, and the folders of files of the projects.
 * @param host The server.
 * @returns The spaces whose reading is not refused, for a file at least.
 */
function fileSpaces(host: McpHost): AgentFileSpace[] {
  const { mcp } = host.config.adt;
  const declared = [
    {
      id: host.fileSpaces.configsSpace,
      name: "Configs of the environment",
      rules: mcp.environment,
      rulesOf: (filePath: string) => environmentRules(mcp, filePath),
      readable: [mcp.environment, ...mcp.environmentItems.filter((item) => item.kind === "file").map((item) => item.rules)].some((rules) => rules.read.level !== "deny"),
    },
    ...Object.values(host.config.projects).flatMap((section) =>
      Object.values(section.directories).flatMap((project) =>
        Object.values(project.files).map((files) => ({
          id: `${section.slug}/${project.slug}/${files.slug}`,
          name: files.name,
          rules: files.mcp,
          rulesOf: () => files.mcp,
          readable: files.mcp.read.level !== "deny",
        })),
      ),
    ),
  ];
  return declared.flatMap(({ readable, ...item }) => {
    const space = host.fileSpaces.get(item.id);
    return space && readable ? [{ ...item, space }] : [];
  });
}

/**
 * Finds a space of files an agent may see.
 * @param host The server.
 * @param id The identifier of the space.
 * @returns The space.
 * @throws {McpToolError} When there is none.
 */
function findSpace(host: McpHost, id: string): AgentFileSpace {
  const space = fileSpaces(host).find((item) => item.id === id);
  if (!space) {
    throw new McpToolError(`No file space ${id}; list_files gives the spaces`);
  }
  return space;
}

/**
 * Replaces every value of a map by its type, keeping its keys.
 * @param value The value.
 * @returns The value with its type in place of every scalar.
 */
export function maskValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return `<list:${value.length}>`;
  }
  if (value === null || value === "") {
    return value;
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskValues(item)]));
  }
  return `<${typeof value}>`;
}

/**
 * Gives the keys of a file of a format read key by key, every value replaced by its type.
 * @param filePath The path of the file.
 * @param content Its content.
 * @returns The keys.
 * @throws {McpToolError} When the format cannot be read key by key.
 */
function keysOf(filePath: string, content: string): unknown {
  const format = configFormatOf(filePath);
  if (!format) {
    throw new McpToolError(`${filePath} is not a file read key by key (YAML, JSON or .env)`);
  }
  return maskValues(format.read(content, filePath));
}

/**
 * Refuses any change of the configuration of the devtool, which holds the rules of agents.
 * @param host The server.
 * @param space The space.
 * @param paths The paths changed.
 * @throws {McpRefusal} When one of them is the configuration of the devtool.
 */
function refuseDevtoolConfig(host: McpHost, space: AgentFileSpace, ...paths: (string | undefined)[]): void {
  if (paths.some((filePath) => filePath && host.fileSpaces.holdsDevtoolConfig(space.id, filePath))) {
    throw new McpRefusal("config", "Refused: agents never change the configuration of the devtool", "devtool");
  }
}

/**
 * Decides a change of a file of a space.
 * @param call The call.
 * @param space The space.
 * @param filePath The path of the file.
 * @param title Describes the call to a person.
 * @param extra What else the request shows.
 * @param extra.keysOnly Whether the change touches keys only.
 * @param extra.details The details of the change.
 * @param extra.diff The content before and after.
 */
async function authorizeWrite(
  call: McpCall,
  space: AgentFileSpace,
  filePath: string,
  title: string,
  extra: { keysOnly?: boolean; details?: McpDetail[]; diff?: { path: string; before: string; after: string } } = {},
): Promise<void> {
  call.describe(`${space.id}:${filePath}`);
  await call.authorize({
    action: "write",
    rule: space.rulesOf(filePath).write,
    keysOnly: extra.keysOnly,
    title,
    details: [{ label: "Space", value: space.name }, { label: "File", value: filePath }, ...(extra.details ?? [])],
    diff: extra.diff,
    grantKey: `write:${space.id}:${filePath}`,
    grantLabel: `Write ${space.id}:${filePath}`,
  });
}

/**
 * Reads a text file of a space.
 * @param space The space.
 * @param filePath The path of the file.
 * @returns Its content, empty when it does not exist, and its last change.
 * @throws {McpToolError} When it cannot be read or holds binary data.
 */
async function readText(space: AgentFileSpace, filePath: string): Promise<{ content: string; updatedAt: string | null }> {
  const file = await space.space.read(filePath);
  if (file.error) {
    throw new McpToolError(file.error);
  }
  if (file.binary) {
    throw new McpToolError(`${filePath} holds binary data`);
  }
  return { content: file.content ?? "", updatedAt: file.updatedAt };
}

/**
 * Writes a text file of a space, then lets the server publish and handle the change.
 * @param host The server.
 * @param space The space.
 * @param filePath The path of the file.
 * @param content Its new content.
 * @param baseUpdatedAt The last change of the file it was edited from.
 * @returns Its new last change.
 * @throws {McpToolError} When it changed since or could not be written.
 */
async function writeText(host: McpHost, space: AgentFileSpace, filePath: string, content: string, baseUpdatedAt: string | null): Promise<string | null> {
  const file = await space.space.write(filePath, content, baseUpdatedAt);
  if (!file.saved) {
    throw new McpToolError(file.error ?? `${filePath} was not written`);
  }
  await host.afterFileWrite(space.id, filePath);
  return file.updatedAt;
}

/**
 * Gives the tools of the files of the projects and of the environment.
 * @param host The server.
 * @returns The tools.
 */
export function fileTools(host: McpHost): McpTool[] {
  return [
    defineTool({
      name: "list_files",
      title: "List files",
      description: "Without space: lists the spaces of files (folders of the projects, `configs` of the environment) with the levels of agents. With space: lists its files.",
      input: { space: z.string().optional().describe("Identifier of the space") },
      readOnly: true,
      run: async ({ space }, call) => {
        if (!space) {
          return fileSpaces(host).map((item) => ({
            space: item.id,
            name: item.name,
            root: item.space.root,
            editable: item.space.editable,
            levels: { read: item.rules.read.level, write: item.rules.write.level },
          }));
        }
        const target = findSpace(host, space);
        call.describe(target.id);
        await call.authorize({ action: "read", rule: target.rules.read, keysOnly: true, title: `List the files of ${target.name}`, grantKey: `read:${target.id}`, grantLabel: `Read ${target.id}` });
        const tree = await target.space.tree();
        return { ...tree, entries: tree.entries.filter((entry) => entry.kind === "directory" || target.rulesOf(entry.path).read.level !== "deny") };
      },
    }),
    defineTool({
      name: "read_file",
      title: "Read a file",
      description: "Reads a file of a space. `keys` gives the keys of a YAML, JSON or .env file with the type of each value in place of the value, allowed where only keys may be read.",
      input: {
        space: z.string().describe("Identifier of the space"),
        path: z.string().describe("Path of the file in the space"),
        mode: z.enum(["content", "keys"]).optional().describe("content by default"),
      },
      readOnly: true,
      run: async ({ space, path: filePath, mode }, call) => {
        const target = findSpace(host, space);
        const keys = mode === "keys";
        call.describe(`${target.id}:${filePath}`);
        const rule = target.rulesOf(filePath).read;
        await call.authorize({
          action: "read",
          rule,
          keysOnly: keys,
          title: `Read ${keys ? "the keys of " : ""}${filePath}`,
          details: [{ label: "Space", value: target.name }, { label: "File", value: filePath }, { label: "Mode", value: keys ? "keys only" : "content" }],
          grantKey: rule === target.rules.read ? `read:${target.id}` : `read:${target.id}:${filePath}`,
          grantLabel: rule === target.rules.read ? `Read ${target.id}` : `Read ${target.id}:${filePath}`,
        });
        const { content, updatedAt } = await readText(target, filePath);
        return keys ? { path: filePath, updatedAt, keys: keysOf(filePath, content) } : { path: filePath, updatedAt, content };
      },
    }),
    defineTool({
      name: "write_file",
      title: "Write a file",
      description: "Replaces the content of a file of a space, creating it when missing. Give the updatedAt of read_file as baseUpdatedAt to refuse the write when the file changed since.",
      input: {
        space: z.string().describe("Identifier of the space"),
        path: z.string().describe("Path of the file in the space"),
        content: z.string(),
        baseUpdatedAt: z.string().nullable().optional().describe("updatedAt given by read_file, null for a new file"),
      },
      privateInput: ["content"],
      run: async ({ space, path: filePath, content, baseUpdatedAt }, call) => {
        const target = findSpace(host, space);
        refuseDevtoolConfig(host, target, filePath);
        const current = await readText(target, filePath);
        await authorizeWrite(call, target, filePath, `Write ${filePath}`, { diff: { path: filePath, before: current.content, after: content } });
        return { path: filePath, updatedAt: await writeText(host, target, filePath, content, baseUpdatedAt === undefined ? current.updatedAt : baseUpdatedAt) };
      },
    }),
    defineTool({
      name: "update_keys",
      title: "Change keys of a file",
      description: "Sets or removes keys of a YAML, JSON or .env file, keeping its comments and layout, allowed where only keys may be written. Gives the keys afterwards, values replaced by their type.",
      input: {
        space: z.string().describe("Identifier of the space"),
        path: z.string().describe("Path of the file in the space"),
        changes: z
          .array(
            z.object({
              key: z.array(z.string()).min(1).describe("Path of the key, such as [\"db\", \"host\"]"),
              value: z.unknown().optional().describe("New value"),
              remove: z.boolean().optional().describe("Removes the key"),
            }),
          )
          .min(1),
      },
      privateInput: ["changes"],
      run: async ({ space, path: filePath, changes }, call) => {
        const target = findSpace(host, space);
        refuseDevtoolConfig(host, target, filePath);
        const format = configFormatOf(filePath);
        if (!format) {
          throw new McpToolError(`${filePath} is not a file changed key by key (YAML, JSON or .env)`);
        }
        const current = await readText(target, filePath);
        await authorizeWrite(call, target, filePath, `Change keys of ${filePath}`, {
          keysOnly: true,
          details: changes.map((change) => ({ label: change.key.join("."), value: change.remove ? "(removed)" : JSON.stringify(change.value), secret: true })),
        });
        const content = format.write(
          current.content,
          changes.map((change) => ({ path: change.key, value: change.remove ? undefined : change.value })),
        );
        const updatedAt = await writeText(host, target, filePath, content, current.updatedAt);
        return { path: filePath, updatedAt, keys: keysOf(filePath, content) };
      },
    }),
    defineTool({
      name: "change_files",
      title: "Create, remove or rename files",
      description: "Creates a file or folder, removes one with everything it holds, or renames one, in a space whose files may be created.",
      input: {
        space: z.string().describe("Identifier of the space"),
        action: z.enum(["create", "remove", "rename"]),
        path: z.string().describe("Path of the file or folder"),
        to: z.string().optional().describe("New path, to rename"),
        kind: z.enum(["file", "directory"]).optional().describe("What is created, file by default"),
      },
      run: async ({ space, action, path: filePath, to, kind }, call) => {
        const target = findSpace(host, space);
        refuseDevtoolConfig(host, target, filePath, to);
        if (action === "rename" && !to) {
          throw new McpToolError("Give the new path in `to`");
        }
        await authorizeWrite(call, target, filePath, `${action[0].toUpperCase()}${action.slice(1)} ${filePath}${to ? ` to ${to}` : ""}`, {
          details: [{ label: "Action", value: action === "create" ? `create ${kind ?? "file"}` : action }, ...(to ? [{ label: "New path", value: to }] : [])],
        });
        const error = await host.changeFiles(target.id, (files) =>
          action === "create" ? files.create(filePath, kind ?? "file") : action === "remove" ? files.remove(filePath) : files.rename(filePath, to as string),
        );
        if (error) {
          throw new McpToolError(error);
        }
        return { space: target.id, action, path: filePath, to: to ?? null };
      },
    }),
  ];
}
