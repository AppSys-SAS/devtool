import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigFolder } from "@appsys/devtool-config";

/**
 * Gives the folder of the environment when the configuration names none: the parent of the configuration folder.
 *
 * @returns The absolute path.
 */
export function defaultEnvironmentFolder(): string {
  return path.dirname(resolveConfigFolder());
}

/**
 * Gives the local path of a devtool file of the CDN.
 *
 * @param folder - The folder of the environment, mirroring the devtool files of the CDN.
 * @param filePath - The path of the file on the CDN, such as `account/config.yml`.
 * @returns The absolute local path.
 */
export function localPathOf(folder: string, filePath: string): string {
  return path.join(folder, filePath);
}

/**
 * Writes a local file readable by the current user only, replaced only once fully written.
 *
 * @param localPath - The file.
 * @param content - Its content, as text, bytes or a stream.
 */
export async function writeLocalFile(localPath: string, content: Parameters<typeof fs.writeFile>[1]): Promise<void> {
  await fs.mkdir(path.dirname(localPath), { recursive: true, mode: 0o700 });
  const partialPath = `${localPath}.part`;
  try {
    await fs.writeFile(partialPath, content, { mode: 0o600 });
    await fs.rename(partialPath, localPath);
  } finally {
    await fs.rm(partialPath, { force: true });
  }
}
