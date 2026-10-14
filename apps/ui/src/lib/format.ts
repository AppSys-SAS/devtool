const UNITS = ["B", "KB", "MB", "GB"];
const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 30],
  ["month", 12],
  ["year", Number.POSITIVE_INFINITY],
];
const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/**
 * Formats a size in bytes for reading.
 * @param bytes The size.
 * @returns The size with its unit, such as `34 KB`.
 */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
}

/**
 * Formats a date relatively to now.
 * @param date The date, in ISO format.
 * @param now The current time, in milliseconds since the epoch.
 * @returns The relative date, such as `5 minutes ago`.
 */
export function formatRelativeDate(date: string, now = Date.now()): string {
  let value = (new Date(date).getTime() - now) / 1000;
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(value) < size) {
      return relativeFormat.format(Math.round(value), unit);
    }
    value /= size;
  }

  return relativeFormat.format(Math.round(value), "year");
}
