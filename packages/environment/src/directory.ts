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

const heldLocks = new Set<string>()

/**
 * Runs a task while holding a lock file, created exclusively and holding the identifier of the
 * holding process: the task is refused while this process or another one holds the lock. A lock
 * left by a process stopped abruptly stays until it is removed, as the refusal says.
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
  try {
    await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 })
    await fs.writeFile(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    heldLocks.delete(lockPath)
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
    const holder = (await fs.readFile(lockPath, 'utf-8').catch(() => '')).trim()
    throw new Error(`${name} is in use by another process${holder === '' ? '' : ` (${holder})`}: try again once it ends, or remove ${lockPath} if none runs`, { cause: error })
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
