import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The version of lego the devtool runs. */
export const LEGO_VERSION = "5.6.0";

/** The release archive of each supported `<platform>-<arch>` and its SHA-256, from the checksums of the release. */
const LEGO_ARCHIVES: Record<string, { file: string; sha256: string }> = {
  "darwin-arm64": { file: `lego_v${LEGO_VERSION}_darwin_arm64.tar.gz`, sha256: "37453b4e1ad7e5d55a969508765db004122b9acbcfe099b95cafb86d0025a383" },
  "darwin-x64": { file: `lego_v${LEGO_VERSION}_darwin_amd64.tar.gz`, sha256: "0c2b5c5e65c20fbd28f28331de24bf315fa4a8669beb0d75fd7eae530d10e0f4" },
  "linux-x64": { file: `lego_v${LEGO_VERSION}_linux_amd64.tar.gz`, sha256: "f02fc11b6f56b97e387fa7caa0268f86f5a336953b22458e6430e4651fea439a" },
  "linux-arm64": { file: `lego_v${LEGO_VERSION}_linux_arm64.tar.gz`, sha256: "34d87a6552d69390c4a4560237045c47713a8e148d899e16db0e97040894ed1f" },
};

/**
 * Gives the release archive of lego for a platform.
 * @param platform - The operating system, as `process.platform` names it.
 * @param arch - The processor, as `process.arch` names it.
 * @returns The file name of the archive and its SHA-256.
 * @throws When lego is not offered for the platform.
 */
export function legoArchive(platform: string = process.platform, arch: string = process.arch): { file: string; sha256: string } {
  const archive = LEGO_ARCHIVES[`${platform}-${arch}`];
  if (!archive) {
    throw new Error(`lego is not available for ${platform}-${arch} (supported: ${Object.keys(LEGO_ARCHIVES).join(", ")})`);
  }
  return archive;
}

/**
 * Checks that an archive is the expected one.
 * @param content - The downloaded archive.
 * @param sha256 - Its expected SHA-256, in hexadecimal.
 * @throws When the archive differs.
 */
export function verifyArchive(content: Buffer, sha256: string): void {
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== sha256) {
    throw new Error(`the lego archive does not match its checksum (expected ${sha256}, got ${actual})`);
  }
}

const installations = new Map<string, Promise<string>>();

/**
 * Gives the lego executable of the devtool, downloading, checking and extracting the release of its
 * version for this platform the first time, then removing the other versions kept in the folder; calls
 * made while an installation runs share it.
 * @param folder - The folder holding one subfolder per version of lego.
 * @param log - Receives the progress.
 * @returns The absolute path of the executable.
 */
export function installLego(folder: string, log: (line: string) => void = () => {}): Promise<string> {
  let installation = installations.get(folder);
  if (!installation) {
    installation = install(folder, log).finally(() => installations.delete(folder));
    installations.set(folder, installation);
  }
  return installation;
}

/**
 * Installs the lego executable of the devtool when missing, then removes the other versions.
 * @param folder - The folder holding one subfolder per version of lego.
 * @param log - Receives the progress.
 * @returns The absolute path of the executable.
 */
async function install(folder: string, log: (line: string) => void): Promise<string> {
  const versionFolder = path.join(folder, LEGO_VERSION);
  const executable = path.join(versionFolder, "lego");
  const installed = await fs.access(executable, fs.constants.X_OK).then(() => true, () => false);
  if (!installed) {
    const archive = legoArchive();
    const url = `https://github.com/go-acme/lego/releases/download/v${LEGO_VERSION}/${archive.file}`;
    log(`Downloading lego ${LEGO_VERSION} (${archive.file})`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`lego download failed: ${response.status} ${response.statusText} (${url})`);
    }
    const content = Buffer.from(await response.arrayBuffer());
    verifyArchive(content, archive.sha256);

    await fs.mkdir(folder, { recursive: true });
    const staging = await fs.mkdtemp(path.join(folder, `.${LEGO_VERSION}-`));
    try {
      const archivePath = path.join(staging, archive.file);
      await fs.writeFile(archivePath, content);
      await execFileAsync("tar", ["-xzf", archivePath, "-C", staging, "lego"]);
      await fs.rm(archivePath);
      await fs.chmod(path.join(staging, "lego"), 0o755);
      await fs.rm(versionFolder, { recursive: true, force: true });
      await fs.rename(staging, versionFolder);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
    log(`lego ${LEGO_VERSION} installed`);
  }

  for (const entry of await fs.readdir(folder)) {
    if (entry !== LEGO_VERSION) {
      await fs.rm(path.join(folder, entry), { recursive: true, force: true });
    }
  }
  return executable;
}
