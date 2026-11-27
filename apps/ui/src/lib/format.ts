const BYTE_UNITS = ['B', 'KB', 'MB', 'GB']
const BYTE_RATIOS = [1024, 1024, 1024]
const TIME_UNITS: Intl.RelativeTimeFormatUnit[] = ['second', 'minute', 'hour', 'day', 'month', 'year']
const TIME_RATIOS = [60, 60, 24, 30, 12]
const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

/**
 * Rounds a number to the nearest integer, halves going away from zero so that opposite values round alike.
 * @param value The number.
 * @returns The rounded number.
 */
function roundHalfAwayFromZero (value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value))
}

/**
 * Expresses a quantity in the first unit of a scale whose displayed value stays below one of the next unit,
 * the last unit taking any value.
 * @param value The quantity, in the first unit of the scale.
 * @param ratios The number of each unit that makes the next one.
 * @param display Rounds a value expressed in the unit at the given index to the value displayed.
 * @returns The index of the chosen unit and the value displayed in it.
 */
function pickUnit (value: number, ratios: number[], display: (value: number, unit: number) => number): [number, number] {
  let scaled = value
  for (const [unit, ratio] of ratios.entries()) {
    const shown = display(scaled, unit)
    if (Math.abs(shown) < ratio) {
      return [unit, shown]
    }
    scaled /= ratio
  }

  return [ratios.length, display(scaled, ratios.length)]
}

/**
 * Rounds a size for display: whole bytes, else one decimal below 10 and whole numbers from 10.
 * @param value The size, in the unit at the given index.
 * @param unit The index of the unit.
 * @returns The displayed size.
 */
function roundSize (value: number, unit: number): number {
  if (unit === 0) {
    return roundHalfAwayFromZero(value)
  }

  const tenths = roundHalfAwayFromZero(value * 10) / 10
  return Math.abs(tenths) < 10 ? tenths : roundHalfAwayFromZero(value)
}

/**
 * Formats a size in bytes for reading.
 * @param bytes The size.
 * @returns The size with its unit, such as `34 KB` or `1.5 MB`.
 */
export function formatBytes (bytes: number): string {
  const [unit, size] = pickUnit(bytes, BYTE_RATIOS, roundSize)
  return `${unit === 0 || Math.abs(size) >= 10 ? size : size.toFixed(1)} ${BYTE_UNITS[unit]}`
}

/**
 * Gives the share of a transfer done.
 * @param done The bytes moved.
 * @param total The size of the file, null when unknown.
 * @returns The whole percentage done, at most 100, null when the size is unknown or empty.
 */
export function progressPercent (done: number, total: number | null): number | null {
  return total ? Math.min(100, Math.floor((done * 100) / total)) : null
}

/**
 * Formats the progress of a transfer for reading.
 * @param done The bytes moved.
 * @param total The size of the file, null when unknown.
 * @returns The bytes moved, with the size and the percentage when the size is known, such as `1.5 MB / 3.0 MB · 50%`.
 */
export function formatProgress (done: number, total: number | null): string {
  return total ? `${formatBytes(done)} / ${formatBytes(total)} · ${progressPercent(done, total)}%` : formatBytes(done)
}

/**
 * Formats a date relatively to now.
 * @param date The date, in ISO format.
 * @param now The current time, in milliseconds since the epoch.
 * @returns The relative date, such as `5 minutes ago`, or an empty string when the date or the current time is invalid.
 */
export function formatRelativeDate (date: string, now = Date.now()): string {
  const seconds = (new Date(date).getTime() - now) / 1000
  if (Number.isNaN(seconds)) {
    return ''
  }

  const [unit, value] = pickUnit(seconds, TIME_RATIOS, roundHalfAwayFromZero)
  return relativeFormat.format(value, TIME_UNITS[unit])
}
