import fs from "node:fs/promises";
import { createRequire } from "node:module";
import type { ServerResponse } from "node:http";
import type { IconifyJSON } from "@iconify/types";
import { getIcons } from "@iconify/utils";
import { logger } from "@appsys/devtool-shared";

/** Path under which icons are served, in the format of the Iconify API. */
export const ICONS_PATH = "/icons/";

const ICON_REQUEST = /^\/icons\/([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/;

const require = createRequire(import.meta.url);

const iconSets = new Map<string, Promise<IconifyJSON | null>>();

/**
 * Reads an icon set from its installed `@iconify-json/<prefix>` package.
 * @param prefix The prefix of the icon set.
 * @returns The icon set, null when its package is not installed.
 */
async function readIconSet(prefix: string): Promise<IconifyJSON | null> {
  try {
    const content = await fs.readFile(require.resolve(`@iconify-json/${prefix}/icons.json`), "utf-8");
    return JSON.parse(content) as IconifyJSON;
  } catch {
    logger.warn("Icons", prefix, `Icon set not installed: add @iconify-json/${prefix} to the server`);
    return null;
  }
}

/**
 * Gives an icon set, read once per prefix.
 * @param prefix The prefix of the icon set.
 * @returns The icon set, null when its package is not installed.
 */
function loadIconSet(prefix: string): Promise<IconifyJSON | null> {
  let iconSet = iconSets.get(prefix);
  if (!iconSet) {
    iconSet = readIconSet(prefix);
    iconSets.set(prefix, iconSet);
  }
  return iconSet;
}

/**
 * Answers an Iconify API request (`/icons/<prefix>.json?icons=a,b`) from the installed icon sets.
 * @param requestUrl The URL of the request, path and query.
 * @param res The response to write to.
 * @returns True when the request is an icon request, answered.
 */
export async function serveIcons(requestUrl: string, res: ServerResponse): Promise<boolean> {
  const url = new URL(requestUrl, "http://localhost");
  if (!url.pathname.startsWith(ICONS_PATH)) {
    return false;
  }

  const prefix = ICON_REQUEST.exec(url.pathname)?.[1];
  const iconSet = prefix ? await loadIconSet(prefix) : null;
  const names = url.searchParams.get("icons")?.split(",").filter(Boolean) ?? [];
  const icons = iconSet && names.length ? getIcons(iconSet, names, true) : null;
  if (!icons) {
    res.writeHead(404);
    res.end("404 Not Found");
    return true;
  }

  res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=86400" });
  res.end(JSON.stringify(icons));
  return true;
}
