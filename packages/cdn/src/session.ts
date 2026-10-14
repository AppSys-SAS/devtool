import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { localPathOf } from "./directory.js";
import type { CdnOptions } from "./options.js";

/** Tokens of a signed-in developer, kept between runs. */
export interface CdnSession {
  issuer: string;
  clientId: string;
  accessToken: string;
  /** Expiry of the access token, in milliseconds since the epoch. */
  expiresAt: number;
  refreshToken: string | null;
}

const SESSION_PATH = localPathOf("devtool/session.json");
const LOCK_PATH = `${SESSION_PATH}.lock`;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;
const LOCK_RETRY_MS = 100;

/**
 * Reads the saved session of an issuer and client.
 *
 * @param options - The CDN options naming the issuer and client.
 * @returns The session, or null when none is saved for them.
 */
export async function readSession(options: CdnOptions): Promise<CdnSession | null> {
  let session: CdnSession;
  try {
    session = JSON.parse(await fs.readFile(SESSION_PATH, "utf-8")) as CdnSession;
  } catch {
    return null;
  }

  return session.issuer === options.issuer && session.clientId === options.clientId ? session : null;
}

/**
 * Saves a session, readable by the current user only.
 *
 * @param session - The session.
 */
export async function writeSession(session: CdnSession): Promise<void> {
  await fs.mkdir(path.dirname(SESSION_PATH), { recursive: true, mode: 0o700 });
  const temporaryPath = `${SESSION_PATH}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(session), { mode: 0o600 });
  await fs.rename(temporaryPath, SESSION_PATH);
}

/**
 * Forgets the saved session.
 */
export async function deleteSession(): Promise<void> {
  await fs.rm(SESSION_PATH, { force: true });
}

/**
 * Runs a task while holding the session lock, shared by every devtool process, so a single one
 * renews the tokens at a time.
 *
 * @param task - The task.
 * @returns The result of the task.
 */
export async function withSessionLock<T>(task: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(LOCK_PATH), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await (await fs.open(LOCK_PATH, "wx", 0o600)).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      const lockedAt = await fs.stat(LOCK_PATH).then((stat) => stat.mtimeMs).catch(() => 0);
      if (Date.now() - lockedAt > LOCK_STALE_MS) {
        await fs.rm(LOCK_PATH, { force: true });
        continue;
      }

      if (Date.now() > deadline) {
        throw new Error(`the devtool session stays locked (${LOCK_PATH})`);
      }

      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await task();
  } finally {
    await fs.rm(LOCK_PATH, { force: true });
  }
}
