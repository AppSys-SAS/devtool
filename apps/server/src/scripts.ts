import { isUtf8 } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import type { DirectoryDefinition, ScriptPayload } from "@appsys/devtool-shared";

const HEADER_BYTES = 8192;

/**
 * Reads the comment heading a script: the `#` lines that follow its shebang.
 *
 * @param scriptPath - Absolute path of the script.
 * @returns The lines without their `#`, empty when the script is not text.
 */
async function headerOf(scriptPath: string): Promise<string[]> {
  const file = await fs.open(scriptPath, "r");
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(HEADER_BYTES), 0, HEADER_BYTES, 0);
    const head = buffer.subarray(0, bytesRead);
    const lines = (isUtf8(head) ? head.toString("utf-8") : "").split("\n");
    const header: string[] = [];
    for (const line of lines.slice(lines[0]?.startsWith("#!") ? 1 : 0)) {
      if (!line.startsWith("#")) {
        break;
      }
      header.push(line.replace(/^# ?/, ""));
    }
    return header;
  } finally {
    await file.close();
  }
}

/**
 * Describes a script from its heading comment: its first paragraph, and its `Usage:` line with the
 * indented lines that follow it.
 *
 * @param header - The lines of the heading comment.
 * @returns The summary and the usage, null when missing.
 */
function describe(header: string[]): { summary: string | null; usage: string | null } {
  const usageStart = header.findIndex((line) => /^usage:/i.test(line.trim()));
  const summaryEnd = header.findIndex((line, index) => !line.trim() || index === usageStart);
  const summary = header.slice(0, summaryEnd === -1 ? header.length : summaryEnd).join(" ").trim();

  let usage: string | null = null;
  if (usageStart !== -1) {
    const usageLines = [header[usageStart].trim().replace(/^usage:\s*/i, "")];
    for (const line of header.slice(usageStart + 1)) {
      if (!/^\s/.test(line)) {
        break;
      }
      usageLines.push(line);
    }
    usage = usageLines.join("\n");
  }

  return { summary: summary || null, usage };
}

/**
 * Lists the scripts of a directory: the executable files of its script folders matching their
 * patterns, hidden ones left out, with what the configuration declares about them.
 *
 * @param directory - The directory.
 * @returns The scripts, sorted by path, their paths relative to the directory and runnable from it.
 */
export async function listScripts(directory: DirectoryDefinition): Promise<ScriptPayload[]> {
  const scripts: ScriptPayload[] = [];
  for (const folder of directory.scripts) {
    for (const dirent of await fs.readdir(folder.path, { withFileTypes: true })) {
      const scriptPath = path.join(folder.path, dirent.name);
      const offered = folder.only === null || folder.only.some((pattern) => path.matchesGlob(dirent.name, pattern));
      if (dirent.name.startsWith(".") || !offered || !dirent.isFile() || ((await fs.stat(scriptPath)).mode & 0o111) === 0) {
        continue;
      }

      const relativePath = path.relative(directory.path, scriptPath);
      const settings = folder.scripts[dirent.name];
      scripts.push({
        path: relativePath.startsWith("..") ? relativePath : `./${relativePath}`,
        name: dirent.name,
        ...describe(await headerOf(scriptPath)),
        prompt: settings?.prompt ?? folder.prompt,
        args: settings?.args ?? null,
      });
    }
  }
  return scripts.sort((a, b) => a.path.localeCompare(b.path));
}
