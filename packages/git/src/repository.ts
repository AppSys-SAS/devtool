import { execFileSync } from "node:child_process";

/** A repository hosted by a forge. */
export interface ForgeRepository {
  /** The host of the forge, with its port when it is not the default one. */
  host: string;
  /** The path of the repository on the forge, such as `group/subgroup/repo`. */
  path: string;
  /** The web address of the repository. */
  webUrl: string;
}

const SCP_REMOTE = /^[^@/\s]+@([^:/\s]+):(.+)$/;

/**
 * Reads a repository from its web address or a remote of git, https, ssh or `user@host:path`.
 * @param url The address.
 * @returns The repository, null when the address names none.
 */
export function repositoryOf(url: string): ForgeRepository | null {
  const scp = SCP_REMOTE.exec(url.trim());
  let protocol = "https:";
  let host: string;
  let pathname: string;
  if (scp) {
    [, host, pathname] = scp;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      return null;
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      protocol = parsed.protocol;
      host = parsed.host;
    } else if (parsed.protocol === "ssh:" || parsed.protocol === "git+ssh:") {
      host = parsed.hostname;
    } else {
      return null;
    }
    pathname = parsed.pathname;
  }

  const path = pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return path.includes("/") ? { host, path, webUrl: `${protocol}//${host}/${path}` } : null;
}

/**
 * Gives the address of the `origin` remote of a working copy.
 * @param folder A folder of the working copy.
 * @returns The address, null when git gives none.
 */
export function originUrl(folder: string): string | null {
  try {
    return execFileSync("git", ["-C", folder, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}
