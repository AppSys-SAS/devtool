import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatBytes, formatProgress, formatRelativeDate, progressPercent } from '@/lib/format'

const KB = 1024
const MB = 1024 ** 2
const GB = 1024 ** 3

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 12 * MONTH

const now = Date.parse('2026-01-15T12:00:00Z')

/**
 * Builds the ISO date found at an offset from the reference time.
 * @param offset - The offset in milliseconds, negative for the past.
 * @returns The ISO date.
 */
function at (offset: number): string {
  return new Date(now + offset).toISOString()
}

describe('progressPercent', () => {
  it.each([
    [0, 4 * MB, 0],
    [MB, 4 * MB, 25],
    [4 * MB - 1, 4 * MB, 99],
    [4 * MB, 4 * MB, 100],
    [5 * MB, 4 * MB, 100],
    [MB, null, null],
    [0, 0, 100]
  ])('gives %i of %s as %s', (done, total, expected) => {
    expect(progressPercent(done, total)).toBe(expected)
  })
})

describe('formatProgress', () => {
  it('shows the bytes moved, the size and the percentage when the size is known', () => {
    expect(formatProgress(1.5 * MB, 3 * MB)).toBe('1.5 MB / 3.0 MB · 50%')
  })

  it('says the size is unknown, with the bytes moved once some are', () => {
    expect(formatProgress(12 * KB, null)).toBe('12 KB / size unknown')
    expect(formatProgress(0, null)).toBe('size unknown')
  })

  it('shows an empty file as complete', () => {
    expect(formatProgress(0, 0)).toBe('0 B / 0 B · 100%')
  })

  it('adds the speed when it is known, the size known or not', () => {
    expect(formatProgress(1.5 * MB, 3 * MB, 2 * MB)).toBe('1.5 MB / 3.0 MB · 50% · 2.0 MB/s')
    expect(formatProgress(12 * KB, null, 512 * KB)).toBe('12 KB / size unknown · 512 KB/s')
  })
})

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1, '1 B'],
    [512, '512 B'],
    [1023, '1023 B']
  ])('keeps %d bytes as whole bytes', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })

  it.each([
    [0.4, '0 B'],
    [0.5, '1 B'],
    [512.4, '512 B'],
    [512.6, '513 B']
  ])('rounds the fractional size %d to whole bytes', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })

  it.each([
    [1023.4, '1023 B'],
    [1023.5, '1.0 KB'],
    [1023.6, '1.0 KB'],
    [1023.4 * KB, '1023 KB'],
    [1023.5 * KB, '1.0 MB'],
    [MB - 1, '1.0 MB'],
    [1023.4 * MB, '1023 MB'],
    [GB - 1, '1.0 GB']
  ])('moves %d bytes to the next unit once the rounded size reaches it', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })

  it.each([
    [10188, '9.9 KB'],
    [10189, '10 KB'],
    [10239, '10 KB'],
    [10 * MB - 1, '10 MB'],
    [10 * GB - 1, '10 GB']
  ])('drops the decimal of %d bytes once the rounded size reaches 10', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })

  it.each([
    [KB, '1.0 KB'],
    [KB + 1, '1.0 KB'],
    [1.5 * KB, '1.5 KB'],
    [9.9 * KB, '9.9 KB'],
    [10 * KB, '10 KB'],
    [10.4 * KB, '10 KB'],
    [10.5 * KB, '11 KB'],
    [34 * KB, '34 KB'],
    [1023 * KB, '1023 KB']
  ])('formats %d bytes in kilobytes', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })

  it.each([
    [MB, '1.0 MB'],
    [2.5 * MB, '2.5 MB'],
    [9.9 * MB, '9.9 MB'],
    [10 * MB, '10 MB'],
    [1023 * MB, '1023 MB']
  ])('formats %d bytes in megabytes', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })

  it.each([
    [GB, '1.0 GB'],
    [5 * GB, '5.0 GB'],
    [9.9 * GB, '9.9 GB'],
    [10 * GB, '10 GB'],
    [1023 * GB, '1023 GB']
  ])('formats %d bytes in gigabytes', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })

  it.each([
    [1024 * GB, '1024 GB'],
    [2048 * GB, '2048 GB'],
    [1024 * 1024 * GB, '1048576 GB']
  ])('stops at gigabytes for %d bytes', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })
})

describe('formatRelativeDate', () => {
  describe('with an explicit now', () => {
    it('reads the same instant as now', () => {
      expect(formatRelativeDate(at(0), now)).toBe('now')
    })

    it.each([
      [-SECOND, '1 second ago'],
      [SECOND, 'in 1 second'],
      [-30 * SECOND, '30 seconds ago'],
      [30 * SECOND, 'in 30 seconds'],
      [-59 * SECOND, '59 seconds ago'],
      [59 * SECOND, 'in 59 seconds']
    ])('counts an offset of %d ms in seconds', (offset, expected) => {
      expect(formatRelativeDate(at(offset), now)).toBe(expected)
    })

    it.each([
      [-0.4 * SECOND, 'now'],
      [0.4 * SECOND, 'now'],
      [-1.4 * SECOND, '1 second ago'],
      [1.6 * SECOND, 'in 2 seconds']
    ])('rounds an offset of %d ms to whole seconds', (offset, expected) => {
      expect(formatRelativeDate(at(offset), now)).toBe(expected)
    })

    it.each([
      [-0.5 * SECOND, '1 second ago'],
      [0.5 * SECOND, 'in 1 second'],
      [-1.5 * SECOND, '2 seconds ago'],
      [1.5 * SECOND, 'in 2 seconds'],
      [-90 * SECOND, '2 minutes ago'],
      [90 * SECOND, 'in 2 minutes'],
      [-2.5 * HOUR, '3 hours ago'],
      [2.5 * HOUR, 'in 3 hours']
    ])('rounds the half offset %d ms away from now', (offset, expected) => {
      expect(formatRelativeDate(at(offset), now)).toBe(expected)
    })

    it.each([
      [-59.4 * SECOND, '59 seconds ago'],
      [-59.5 * SECOND, '1 minute ago'],
      [-59.6 * SECOND, '1 minute ago'],
      [59.6 * SECOND, 'in 1 minute'],
      [-59.4 * MINUTE, '59 minutes ago'],
      [-59.6 * MINUTE, '1 hour ago'],
      [59.6 * MINUTE, 'in 1 hour'],
      [-23.4 * HOUR, '23 hours ago'],
      [-23.5 * HOUR, 'yesterday'],
      [23.5 * HOUR, 'tomorrow'],
      [-29.4 * DAY, '29 days ago'],
      [-29.6 * DAY, 'last month'],
      [29.6 * DAY, 'next month'],
      [-11.4 * MONTH, '11 months ago'],
      [-345 * DAY, 'last year'],
      [345 * DAY, 'next year']
    ])('moves an offset of %d ms to the next unit once the rounded value reaches it', (offset, expected) => {
      expect(formatRelativeDate(at(offset), now)).toBe(expected)
    })

    it.each([
      [''],
      ['not a date'],
      ['2026-13-45']
    ])('reads the invalid date %j as an empty string', date => {
      expect(formatRelativeDate(date, now)).toBe('')
    })

    it('reads an invalid now as an empty string', () => {
      expect(formatRelativeDate(at(0), Number.NaN)).toBe('')
    })

    it.each([
      [-MINUTE, '1 minute ago'],
      [MINUTE, 'in 1 minute'],
      [-5 * MINUTE, '5 minutes ago'],
      [5 * MINUTE, 'in 5 minutes'],
      [-59 * MINUTE, '59 minutes ago'],
      [59 * MINUTE, 'in 59 minutes']
    ])('counts an offset of %d ms in minutes', (offset, expected) => {
      expect(formatRelativeDate(at(offset), now)).toBe(expected)
    })

    it.each([
      [-HOUR, '1 hour ago'],
      [HOUR, 'in 1 hour'],
      [-3 * HOUR, '3 hours ago'],
      [3 * HOUR, 'in 3 hours'],
      [-23 * HOUR, '23 hours ago'],
      [23 * HOUR, 'in 23 hours']
    ])('counts an offset of %d ms in hours', (offset, expected) => {
      expect(formatRelativeDate(at(offset), now)).toBe(expected)
    })

    it.each([
      [-DAY, 'yesterday'],
      [DAY, 'tomorrow'],
      [-2 * DAY, '2 days ago'],
      [2 * DAY, 'in 2 days'],
      [-29 * DAY, '29 days ago'],
      [29 * DAY, 'in 29 days']
    ])('counts an offset of %d ms in days', (offset, expected) => {
      expect(formatRelativeDate(at(offset), now)).toBe(expected)
    })

    it.each([
      [-MONTH, 'last month'],
      [MONTH, 'next month'],
      [-2 * MONTH, '2 months ago'],
      [2 * MONTH, 'in 2 months'],
      [-11 * MONTH, '11 months ago'],
      [11 * MONTH, 'in 11 months']
    ])('counts an offset of %d ms in months', (offset, expected) => {
      expect(formatRelativeDate(at(offset), now)).toBe(expected)
    })

    it.each([
      [-YEAR, 'last year'],
      [YEAR, 'next year'],
      [-3 * YEAR, '3 years ago'],
      [3 * YEAR, 'in 3 years'],
      [-100 * YEAR, '100 years ago'],
      [100 * YEAR, 'in 100 years']
    ])('counts an offset of %d ms in years', (offset, expected) => {
      expect(formatRelativeDate(at(offset), now)).toBe(expected)
    })

    it.each([
      ['2025-01-15T12:00:00Z', 'last year'],
      ['2027-01-15T12:00:00Z', 'next year'],
      ['2023-01-15T12:00:00Z', '3 years ago']
    ])('reads the calendar date %s in years', (date, expected) => {
      expect(formatRelativeDate(date, now)).toBe(expected)
    })

    it('reads an ISO date with a time zone offset', () => {
      expect(formatRelativeDate('2026-01-15T13:00:00+01:00', now)).toBe('now')
      expect(formatRelativeDate('2026-01-15T12:00:00-01:00', now)).toBe('in 1 hour')
    })

    it('reads a date-only ISO date as midnight UTC', () => {
      expect(formatRelativeDate('2026-01-15', now)).toBe('12 hours ago')
    })
  })

  describe('with the default now', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(now)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('measures from the system time', () => {
      expect(formatRelativeDate(at(0))).toBe('now')
      expect(formatRelativeDate(at(-5 * MINUTE))).toBe('5 minutes ago')
      expect(formatRelativeDate(at(DAY))).toBe('tomorrow')
    })

    it('follows the system time as it moves', () => {
      const date = at(0)
      vi.setSystemTime(now + 2 * HOUR)

      expect(formatRelativeDate(date)).toBe('2 hours ago')
    })

    it('prefers an explicit now over the system time', () => {
      expect(formatRelativeDate(at(0), now + MONTH)).toBe('last month')
    })
  })
})
