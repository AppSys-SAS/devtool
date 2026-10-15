import fs from "node:fs/promises";
import path from "node:path";
import { localPathOf } from "./directory.js";

/** Dates of both copies of an item when they were last made equal by a pull or a push. */
export interface SyncRecord {
  localUpdatedAt: Date;
  remoteUpdatedAt: Date;
}

const JOURNAL_PATH = localPathOf("devtool/sync.json");

/**
 * Reads the synchronization journal of the developer.
 *
 * @returns The records, by item path.
 */
export async function readSyncJournal(): Promise<Map<string, SyncRecord>> {
  let raw: Record<string, { localUpdatedAt: string; remoteUpdatedAt: string }>;
  try {
    raw = JSON.parse(await fs.readFile(JOURNAL_PATH, "utf-8")) as typeof raw;
  } catch {
    return new Map();
  }

  return new Map(Object.entries(raw).map(([itemPath, record]) => [itemPath, { localUpdatedAt: new Date(record.localUpdatedAt), remoteUpdatedAt: new Date(record.remoteUpdatedAt) }]));
}

/**
 * Records the dates of both copies of an item, now equal.
 *
 * @param itemPath - The path of the item.
 * @param record - The dates of its local and CDN copies.
 */
export async function writeSyncRecord(itemPath: string, record: SyncRecord): Promise<void> {
  const journal = await readSyncJournal();
  journal.set(itemPath, record);
  await fs.mkdir(path.dirname(JOURNAL_PATH), { recursive: true, mode: 0o700 });
  const partialPath = `${JOURNAL_PATH}.${process.pid}.part`;
  await fs.writeFile(partialPath, JSON.stringify(Object.fromEntries(journal), null, 2), { mode: 0o600 });
  await fs.rename(partialPath, JOURNAL_PATH);
}
