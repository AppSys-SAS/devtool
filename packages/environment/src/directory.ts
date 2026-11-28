import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveConfigFolder } from '@appsys-sas/devtool-config'

/**
 * Gives the folder of the environment when the configuration names none: the parent of the configuration folder.
 *
 * @returns The absolute path.
 */
export function defaultEnvironmentFolder (): string {
  return path.dirname(resolveConfigFolder())
}

/**
 * Gives the local path of a devtool file of the CDN.
 *
 * @param folder - The folder of the environment, mirroring the devtool files of the CDN.
 * @param filePath - The path of the file on the CDN, such as `account/config.yml`.
 * @returns The absolute local path.
 */
export function localPathOf (folder: string, filePath: string): string {
  return path.join(folder, filePath)
}

const heldLocks = new Set<string>()
const LOCK_RETRY_MS = 50
const swept = new Map<string, Promise<void>>()

/** What a temporary file written next to a local file holds, ending its name. */
export type TemporaryKind = 'part' | 'pull' | 'push' | 'base' | 'merged' | 'sealed'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const TEMPORARY_PART = `${UUID}\\.(?:part|pull|push|base|merged|sealed)`

/** What follows the name of a local file in the names of its temporary files, nested ones included. */
export const TEMPORARY_SUFFIX = new RegExp(`^\\.${TEMPORARY_PART}(?:\\.${TEMPORARY_PART})*$`)

/** A path ending like the name of a temporary file. */
export const TEMPORARY_NAME = new RegExp(`\\.${TEMPORARY_PART}$`)

/**
 * Gives a new path for a temporary file next to a local file, named after it with a unique
 * identifier, so that it never names another file.
 *
 * @param localPath - The local file.
 * @param kind - What the temporary file holds.
 * @returns The path, the file not created.
 */
export function temporaryPathOf (localPath: string, kind: TemporaryKind): string {
  return `${localPath}.${randomUUID()}.${kind}`
}

/**
 * Gives a new path for a temporary file of this process, in a folder readable by the current user
 * only. The folders that processes no longer running left there are removed the first time, those
 * that cannot be removed being tried again by the next process.
 *
 * @param cacheDir - The cache folder of the devtool.
 * @param name - What the file holds, ending its name.
 * @returns The path, the file not created.
 */
export async function scratchPath (cacheDir: string, name: string): Promise<string> {
  const root = path.join(cacheDir, 'environment', 'tmp')
  let sweeping = swept.get(root)
  if (!sweeping) {
    sweeping = fs.readdir(root).catch(() => []).then(async names => {
      await Promise.all(names
        .filter(folder => /^\d+$/.test(folder) && (Number(folder) === process.pid || !isRunning(Number(folder))))
        .map(async folder => fs.rm(path.join(root, folder), { recursive: true, force: true }).catch(() => undefined)))
    })
    swept.set(root, sweeping)
  }
  await sweeping
  const folder = path.join(root, String(process.pid))
  await fs.mkdir(folder, { recursive: true, mode: 0o700 })
  return path.join(folder, `${randomUUID()}.${name}`)
}

/**
 * Tells whether a process runs, one of another user counting as running.
 *
 * @param pid - The identifier of the process.
 * @returns True when it runs.
 */
function isRunning (pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Runs a task while holding a lock file, created exclusively and holding the identifier of the
 * holding process: while this process or another one holds the lock, the task waits for it at most
 * the given time, then is refused. A lock left by a process stopped abruptly, or that could not be
 * removed once the task ended, stays until it is removed, as the refusal says.
 *
 * @param lockPath - The lock file.
 * @param name - What the lock protects, for the error message.
 * @param task - The task.
 * @param waitMs - How long the task waits for a lock already held, none by default.
 * @param signal - Gives up the wait.
 * @returns What the task returns.
 */
export async function withFileLock<T> (lockPath: string, name: string, task: () => Promise<T>, waitMs = 0, signal?: AbortSignal): Promise<T> {
  const deadline = Date.now() + waitMs
  let holder = await takeLock(lockPath)
  while (holder !== null && Date.now() < deadline) {
    await delay(LOCK_RETRY_MS, undefined, { signal })
    holder = await takeLock(lockPath)
  }
  if (holder === String(process.pid) && heldLocks.has(lockPath)) {
    throw new Error(`${name} is in use: try again once it ends`)
  }
  if (holder !== null) {
    throw new Error(`${name} is in use by another process${holder === '' ? '' : ` (${holder})`}: try again once it ends, or remove ${lockPath} if none runs`)
  }
  try {
    return await task()
  } finally {
    await fs.rm(lockPath, { force: true }).catch(() => undefined)
    heldLocks.delete(lockPath)
  }
}

/**
 * Takes a lock file when no task holds it.
 *
 * @param lockPath - The lock file.
 * @returns Null once taken, else the identifier of the process holding it, empty when unknown.
 */
async function takeLock (lockPath: string): Promise<string | null> {
  if (heldLocks.has(lockPath)) {
    return String(process.pid)
  }
  heldLocks.add(lockPath)
  try {
    await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 })
    await fs.writeFile(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 })
    return null
  } catch (error) {
    heldLocks.delete(lockPath)
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
    return (await fs.readFile(lockPath, 'utf-8').catch(() => '')).trim()
  }
}

/**
 * Writes a local file readable by the current user only, replaced only once fully written and
 * never once abandoned; a stream content is closed when the file cannot be written, and the
 * folders created for it are removed again.
 *
 * @param localPath - The file.
 * @param content - Its content, as text, bytes or a stream.
 * @param signal - Abandons the writing, leaving the file as it was.
 */
export async function writeLocalFile (localPath: string, content: Parameters<typeof fs.writeFile>[1], signal?: AbortSignal): Promise<void> {
  const partialPath = temporaryPathOf(localPath, 'part')
  let created: string | undefined
  try {
    created = await fs.mkdir(path.dirname(localPath), { recursive: true, mode: 0o700 })
    await fs.writeFile(partialPath, content, { mode: 0o600 })
    signal?.throwIfAborted()
    await fs.rename(partialPath, localPath)
  } catch (error) {
    if (content instanceof Readable) {
      content.destroy()
    }
    await fs.rm(partialPath, { force: true })
    if (created !== undefined) {
      await removeEmptyFolders(path.dirname(localPath), created)
    }
    throw error
  }
}

/**
 * Removes a folder and its parents while they are empty, up to a given one.
 *
 * @param folder - The deepest folder.
 * @param top - The highest folder removed.
 */
async function removeEmptyFolders (folder: string, top: string): Promise<void> {
  let current = folder
  while (await fs.rmdir(current).then(() => true, () => false) && current !== top) {
    current = path.dirname(current)
  }
}
