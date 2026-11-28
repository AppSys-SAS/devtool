import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveConfigFolder } from '@appsys-sas/devtool-config'
import { TEMPORARY_SUFFIX, temporaryPathOf, withFileLock } from './directory.js'

const JOURNAL_WAIT_MS = 10_000

/** Both copies of an item when they were last made equal by a pull or a push. */
export interface SyncRecord {
  localUpdatedAt: Date
  remoteUpdatedAt: Date
  /** The backend holding the remote copy; missing in records written before backends existed. */
  backend?: string
  /** What the backend gave as version of its copy; missing in records written before versions existed. */
  remoteVersion?: string
}

/**
 * Gives the path of the synchronization journal, in the configuration folder.
 *
 * @returns The absolute path.
 */
function journalPath (): string {
  return path.join(resolveConfigFolder(), 'sync.json')
}

/**
 * Reads the synchronization journal of the developer.
 *
 * @returns The records, by item path.
 */
export async function readSyncJournal (): Promise<Map<string, SyncRecord>> {
  return readJournal().catch(() => new Map<string, SyncRecord>())
}

/**
 * Reads the synchronization journal, a missing journal holding no record.
 *
 * @returns The records, by item path.
 * @throws {Error} When the journal cannot be read or parsed.
 */
async function readJournal (): Promise<Map<string, SyncRecord>> {
  let text: string
  try {
    text = await fs.readFile(journalPath(), 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Map()
    }
    throw error
  }
  const raw = JSON.parse(text) as Record<string, { localUpdatedAt: string, remoteUpdatedAt: string, backend?: string, remoteVersion?: string }>
  return new Map(Object.entries(raw).map(([itemPath, record]) => [itemPath, { ...record, localUpdatedAt: new Date(record.localUpdatedAt), remoteUpdatedAt: new Date(record.remoteUpdatedAt) }]))
}

/**
 * Records both copies of an item, now equal. The records are written one after the other, across
 * the processes of the developer, so that none of them replaces another, and a journal that cannot
 * be read is never replaced. The partial journals a stopped process left are removed first.
 *
 * @param itemPath - The path of the item.
 * @param record - Its local copy and the copy of its backend.
 * @param waitMs - How long the record waits for another process writing the journal.
 */
export async function writeSyncRecord (itemPath: string, record: SyncRecord, waitMs = JOURNAL_WAIT_MS): Promise<void> {
  const file = journalPath()
  await withFileLock(`${file}.lock`, `the synchronization journal ${file}`, async () => {
    const base = path.basename(file)
    const names = await fs.readdir(path.dirname(file)).catch(() => [])
    await Promise.all(names
      .filter(name => name.startsWith(base) && TEMPORARY_SUFFIX.test(name.slice(base.length)))
      .map(async name => fs.rm(path.join(path.dirname(file), name), { force: true })))
    const journal = await readJournal().catch((error: unknown) => {
      throw new Error(`the synchronization journal ${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    })
    journal.set(itemPath, record)
    const partialPath = temporaryPathOf(file, 'part')
    try {
      await fs.writeFile(partialPath, JSON.stringify(Object.fromEntries(journal), null, 2), { mode: 0o600 })
      await fs.rename(partialPath, file)
    } finally {
      await fs.rm(partialPath, { force: true })
    }
  }, waitMs)
}
