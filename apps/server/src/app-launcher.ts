import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type AppIdentity, type RawConfig, resolveAppIdentity, resolveCacheFolder } from "@appsys/devtool-config";
import { logger } from "@appsys/devtool-shared";

const DEFAULT_ICON = fileURLToPath(new URL("../assets/AppIcon.icns", import.meta.url));
const ICONSET_SIZES = [16, 32, 128, 256, 512];
const UNDER_APP_VARIABLE = "DEVTOOL_UNDER_APP";
const LINK_FD = 3;
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const run = promisify(execFile);

/**
 * Escapes a text for an XML document.
 * @param text The text.
 * @returns The text with its markup characters escaped.
 */
function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Writes the property list of the app.
 * @param identity How the devtool names itself.
 * @returns The content of `Info.plist`.
 */
function infoPlist(identity: AppIdentity): string {
  const displayName = escapeXml(identity.displayName);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${displayName}</string>
  <key>CFBundleDisplayName</key><string>${displayName}</string>
  <key>CFBundleIdentifier</key><string>app.appsys.${identity.name}</string>
  <key>CFBundleExecutable</key><string>${displayName}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;
}

/**
 * Turns an image into an `.icns` icon with the tools of macOS: an `.icns` copied as is, an SVG rendered by
 * Quick Look first, every image then resized into an icon set by sips and assembled by iconutil.
 * @param source The image.
 * @param target The icon written.
 * @param work A folder for the intermediate files, removed once done.
 */
async function convertIcon(source: string, target: string, work: string): Promise<void> {
  const extension = path.extname(source).toLowerCase();
  if (extension === ".icns") {
    await fs.copyFile(source, target);
    return;
  }
  const iconset = path.join(work, "AppIcon.iconset");
  await fs.mkdir(iconset, { recursive: true });
  let image = source;
  if (extension === ".svg") {
    await run("qlmanage", ["-t", "-s", "1024", "-o", work, source]);
    image = path.join(work, `${path.basename(source)}.png`);
  }
  for (const size of ICONSET_SIZES) {
    for (const [scale, suffix] of [[1, ""], [2, "@2x"]] as const) {
      const pixels = String(size * scale);
      await run("sips", ["-s", "format", "png", "-z", pixels, pixels, image, "--out", path.join(iconset, `icon_${size}x${size}${suffix}.png`)]);
    }
  }
  await run("iconutil", ["-c", "icns", iconset, "-o", target]);
  await fs.rm(work, { recursive: true, force: true });
}

/**
 * Gives the `.icns` icon of the app: the default one, or the configured image converted once per version
 * of the file and kept in the cache folder.
 * @param source The configured image, null for the default icon.
 * @param cacheDir The cache folder of the devtool.
 * @returns The path of the icon, the default one when the image cannot be converted.
 */
async function appIcon(source: string | null, cacheDir: string): Promise<string> {
  if (!source) {
    return DEFAULT_ICON;
  }
  try {
    const { mtimeMs } = await fs.stat(source);
    const folder = path.join(cacheDir, "app-icons");
    const target = path.join(folder, `${createHash("sha1").update(`${source}:${mtimeMs}`).digest("hex").slice(0, 16)}.icns`);
    if (!(await fs.stat(target).then(() => true, () => false))) {
      await fs.rm(folder, { recursive: true, force: true });
      await fs.mkdir(folder, { recursive: true });
      await convertIcon(source, target, path.join(folder, "work"));
    }
    return target;
  } catch (error) {
    logger.warn("Server", "adt.icon", `Default app icon kept: ${error instanceof Error ? error.message : String(error)}`);
    return DEFAULT_ICON;
  }
}

/**
 * Builds the app named after the devtool whose executable is a hard link to Node, so that the programs
 * it runs, 1Password prompts included, show its name and icon.
 * @param cacheDir The cache folder of the devtool, holding the app.
 * @param identity How the devtool names and shows itself.
 * @returns The path of its executable.
 */
async function createLauncher(cacheDir: string, identity: AppIdentity): Promise<string> {
  const appDirectory = path.join(cacheDir, `${identity.displayName}.app`);
  const executable = path.join(appDirectory, "Contents", "MacOS", identity.displayName);
  const resources = path.join(appDirectory, "Contents", "Resources");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.mkdir(resources, { recursive: true });

  const [node, current] = await Promise.all([fs.stat(process.execPath), fs.stat(executable).catch(() => null)]);
  if (current?.ino !== node.ino || current.dev !== node.dev) {
    await fs.rm(executable, { force: true });
    await fs.link(process.execPath, executable);
  }
  await fs.writeFile(path.join(appDirectory, "Contents", "Info.plist"), infoPlist(identity));
  await fs.copyFile(await appIcon(identity.icon, cacheDir), path.join(resources, "AppIcon.icns"));
  return executable;
}

/**
 * Ends the process once the process that started it is gone, its link closing even when it is killed.
 */
function followStarter(): void {
  const link = new net.Socket({ fd: LINK_FD, readable: true, writable: false });
  link.on("error", () => undefined);
  link.on("close", () => process.exit(0));
  link.resume();
  link.unref();
}

/**
 * Runs the current process again under the app named after the devtool, detached so that the app heads
 * its process tree, the current process then only waiting for it: it stops it on SIGINT, SIGTERM or
 * SIGHUP and ends with it. Does nothing in the process run again, outside macOS, or when the app
 * cannot be built.
 * @param config The merged configuration, giving the cache folder where the app is built and how it is named.
 * @returns True when the current process only waits for the one run under the app.
 */
export async function relaunchUnderApp(config: RawConfig): Promise<boolean> {
  if (process.env[UNDER_APP_VARIABLE] === "1") {
    delete process.env[UNDER_APP_VARIABLE];
    followStarter();
    return false;
  }
  if (process.platform !== "darwin") {
    return false;
  }

  const { identity } = resolveAppIdentity(config);
  let executable: string;
  try {
    executable = await createLauncher(resolveCacheFolder(config), identity);
  } catch (error) {
    logger.warn("Server", identity.displayName, `Not run under the app: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  const env: NodeJS.ProcessEnv = { ...process.env, [UNDER_APP_VARIABLE]: "1" };
  // An IPC channel inherited from a watcher would claim the file descriptor of the link.
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_CHANNEL_SERIALIZATION_MODE;
  const shell = spawn("/bin/sh", ["-c", '"$0" "$@" &', executable, ...process.execArgv, ...process.argv.slice(1)], {
    env,
    stdio: ["ignore", "inherit", "inherit", "pipe"],
  });
  shell.on("error", () => undefined);

  const link = shell.stdio[LINK_FD] as Duplex;
  link.on("error", () => undefined);
  link.on("close", () => process.exit(0));
  for (const signal of STOP_SIGNALS) {
    process.on(signal, () => link.end());
  }
  return true;
}
