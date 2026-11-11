import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Directory of the AppSys development environment, mirroring the devtool files of the CDN. */
export const APPSYS_DIRECTORY = path.join(os.homedir(), ".config/appsys");

/**
 * Gives the local path of a devtool file of the CDN.
 *
 * @param filePath - The path of the file on the CDN, such as `account/config.yml`.
 * @returns The absolute local path.
 */
export function localPathOf(filePath: string): string {
  return path.join(APPSYS_DIRECTORY, filePath);
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
