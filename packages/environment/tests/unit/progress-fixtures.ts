import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { expect } from 'vitest'
import type { TransferProgress } from '../../src/backends/backend.js'

/** Size of the files whose transfers report their progress, several stream chunks long. */
export const PROGRESS_FILE_SIZE = 1024 * 1024

/**
 * Builds content to transfer, random so no compression shrinks it.
 * @returns The content.
 */
export function progressContent (): Buffer {
  return randomBytes(PROGRESS_FILE_SIZE)
}

/**
 * Counts the files the current process holds open.
 * @returns The number of open file descriptors.
 */
export function openDescriptors (): number {
  return readdirSync('/dev/fd').length
}

/**
 * Records what a transfer reports of its progress.
 * @returns The listener to give the transfer, and the reports it received.
 */
export function progressRecorder (): { onProgress: TransferProgress, reports: [number, number | null][] } {
  const reports: [number, number | null][] = []
  return {
    reports,
    onProgress: (done, total) => {
      reports.push([done, total])
    }
  }
}

/**
 * Checks that the reports of a transfer never go back and end at the whole file.
 * @param reports - The reports.
 * @param size - The size of the file.
 * @param minimum - The fewest reports expected.
 */
export function expectCompleteProgress (reports: [number, number | null][], size: number, minimum = 2): void {
  expect(reports.length).toBeGreaterThanOrEqual(minimum)
  expect(reports.at(-1)).toEqual([size, size])
  expect(reports.every(([done], index) => index === 0 || done >= reports[index - 1][0])).toBe(true)
}
