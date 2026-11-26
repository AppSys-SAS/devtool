import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
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

/**
 * Tells whether a process runs.
 *
 * @param pid - The process identifier.
 * @returns True when the process runs, or when it cannot be told.
 */
function runs (pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const heldLocks = new Set<string>()

/**
 * Runs a task while holding a lock file, which holds the identifier of the holding process: the
 * task is refused while this process or another running one holds the lock, and a lock left by a
 * process that no longer runs, or by an earlier process of the same identifier, is taken over.
 *
 * @param lockPath - The lock file.
 * @param name - What the lock protects, for the error message.
 * @param task - The task.
 * @returns What the task returns.
 */
export async function withFileLock<T> (lockPath: string, name: string, task: () => Promise<T>): Promise<T> {
  if (heldLocks.has(lockPath)) {
    throw new Error(`${name} is being transferred: try again once it ends`)
  }
  heldLocks.add(lockPath)
  const take = async (): Promise<void> => fs.writeFile(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 })
  try {
    await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 })
    try {
      await take()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
      const holder = Number(await fs.readFile(lockPath, 'utf-8').catch(() => ''))
      if (!Number.isSafeInteger(holder) || holder <= 0 || (holder !== process.pid && runs(holder))) {
        throw new Error(`${name} is in use by another process${holder > 0 ? ` (${holder})` : ''}: try again once it ends, or remove ${lockPath} if none runs`, { cause: error })
      }
      await fs.rm(lockPath, { force: true })
      await take()
    }
  } catch (error) {
    heldLocks.delete(lockPath)
    throw error
  }
  try {
    return await task()
  } finally {
    await fs.rm(lockPath, { force: true }).finally(() => heldLocks.delete(lockPath))
  }
}

/**
 * Writes a local file readable by the current user only, replaced only once fully written; a
 * stream content is closed when the file cannot be written.
 *
 * @param localPath - The file.
 * @param content - Its content, as text, bytes or a stream.
 */
export async function writeLocalFile (localPath: string, content: Parameters<typeof fs.writeFile>[1]): Promise<void> {
  const partialPath = `${localPath}.part`
  try {
    await fs.mkdir(path.dirname(localPath), { recursive: true, mode: 0o700 })
    await fs.writeFile(partialPath, content, { mode: 0o600 })
    await fs.rename(partialPath, localPath)
  } catch (error) {
    if (content instanceof Readable) {
      content.destroy()
    }
    throw error
  } finally {
    await fs.rm(partialPath, { force: true })
  }
}
