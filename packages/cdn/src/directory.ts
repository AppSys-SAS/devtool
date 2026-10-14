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
