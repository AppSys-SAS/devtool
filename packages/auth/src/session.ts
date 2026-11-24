import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolveConfigFolder } from '@appsys/devtool-config'
import type { AuthSession } from './types.js'

const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 15_000
const LOCK_RETRY_MS = 100

/**
 * Gives the path of the session file, in the configuration folder.
 * @returns The absolute path.
 */
export function sessionPath (): string {
  return path.join(resolveConfigFolder(), 'session.json')
}

/**
 * Gives the path of the lock guarding the session file.
 * @returns The absolute path.
 */
function lockPath (): string {
  return `${sessionPath()}.lock`
}

/**
 * Reads the saved session when it belongs to the current settings.
 * @param owns Tells whether the raw saved session was opened with the current settings.
 * @returns The session, or null when none is saved for them.
 */
export async function readSession (owns: (session: Record<string, unknown>) => boolean): Promise<AuthSession | null> {
  let session: Record<string, unknown>
  try {
    session = JSON.parse(await fs.readFile(sessionPath(), 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }

  return owns(session) ? session as unknown as AuthSession : null
}

/**
 * Saves a session, readable by the current user only.
 * @param session The session.
 */
export async function writeSession (session: AuthSession): Promise<void> {
  await fs.mkdir(path.dirname(sessionPath()), { recursive: true, mode: 0o700 })
  const temporaryPath = `${sessionPath()}.${process.pid}.tmp`
  await fs.writeFile(temporaryPath, JSON.stringify(session), { mode: 0o600 })
  await fs.rename(temporaryPath, sessionPath())
}

/**
 * Forgets the saved session.
 */
export async function deleteSession (): Promise<void> {
  await fs.rm(sessionPath(), { force: true })
}

/**
 * Runs a task while holding the session lock, shared by every devtool process, so a single one
 * renews the tokens at a time.
 * @param task The task.
 * @returns The result of the task.
 */
export async function withSessionLock<T> (task: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(lockPath()), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      await (await fs.open(lockPath(), 'wx', 0o600)).close()
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }

      const lockedAt = await fs.stat(lockPath()).then(stat => stat.mtimeMs).catch(() => 0)
      if (Date.now() - lockedAt > LOCK_STALE_MS) {
        await fs.rm(lockPath(), { force: true })
        continue
      }

      if (Date.now() > deadline) {
        throw new Error(`the devtool session stays locked (${lockPath()})`, { cause: error })
      }

      await sleep(LOCK_RETRY_MS)
    }
  }

  try {
    return await task()
  } finally {
    await fs.rm(lockPath(), { force: true })
  }
}
