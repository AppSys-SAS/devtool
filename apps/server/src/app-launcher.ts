import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { logger } from "@appsys/devtool-shared";

const APP_NAME = "AppSys Devtool";
const APP_ICON = fileURLToPath(new URL("../assets/AppIcon.icns", import.meta.url));
const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>app.appsys.devtool</string>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;
const UNDER_APP_VARIABLE = "DEVTOOL_UNDER_APP";
const LINK_FD = 3;
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Builds the app named after devtool whose executable is a hard link to Node, so that the programs
 * it runs, 1Password prompts included, show its name and icon.
 * @param cacheDir The cache folder of the devtool, holding the app.
 * @returns The path of its executable.
 */
async function createLauncher(cacheDir: string): Promise<string> {
  const appDirectory = path.join(cacheDir, `${APP_NAME}.app`);
  const executable = path.join(appDirectory, "Contents", "MacOS", APP_NAME);
  const resources = path.join(appDirectory, "Contents", "Resources");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.mkdir(resources, { recursive: true });

  const [node, current] = await Promise.all([fs.stat(process.execPath), fs.stat(executable).catch(() => null)]);
  if (current?.ino !== node.ino || current.dev !== node.dev) {
    await fs.rm(executable, { force: true });
    await fs.link(process.execPath, executable);
  }
  await fs.writeFile(path.join(appDirectory, "Contents", "Info.plist"), INFO_PLIST);
  await fs.copyFile(APP_ICON, path.join(resources, "AppIcon.icns"));
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
 * Runs the current process again under the app named after devtool, detached so that the app heads
 * its process tree, the current process then only waiting for it: it stops it on SIGINT, SIGTERM or
 * SIGHUP and ends with it. Does nothing in the process run again, outside macOS, or when the app
 * cannot be built.
 * @param cacheDir The cache folder of the devtool, where the app is built.
 * @returns True when the current process only waits for the one run under the app.
 */
export async function relaunchUnderApp(cacheDir: string): Promise<boolean> {
  if (process.env[UNDER_APP_VARIABLE] === "1") {
    delete process.env[UNDER_APP_VARIABLE];
    followStarter();
    return false;
  }
  if (process.platform !== "darwin") {
    return false;
  }

  let executable: string;
  try {
    executable = await createLauncher(cacheDir);
  } catch (error) {
    logger.warn("Server", APP_NAME, `Not run under the app: ${error instanceof Error ? error.message : String(error)}`);
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
