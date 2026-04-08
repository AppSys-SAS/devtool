const levels = {
  error: 40,
  warn: 30,
  info: 20,
  debug: 10,
} as const;

export type LogLevel = keyof typeof levels;

let currentLevel: number = levels.info;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function log(level: LogLevel, prefix: string, namespace: string, scope: string, ...args: unknown[]): void {
  if (levels[level] < currentLevel) {
    return;
  }

  const now = new Date();
  const time = `${pad(now.getHours(), 2)}:${pad(now.getMinutes(), 2)}:${pad(now.getSeconds(), 2)}:${pad(
    now.getMilliseconds(),
    3,
  )}`;

  // eslint-disable-next-line no-console
  console[level](`[${prefix} ${time}]`, namespace, scope, ...args);
}

export const logger = {
  getLevel(): LogLevel {
    return (Object.entries(levels).find(([, value]) => value === currentLevel)?.[0] ?? "info") as LogLevel;
  },
  setLevel(level: LogLevel): void {
    currentLevel = levels[level] ?? levels.info;
  },
  debug(namespace: string, scope: string, ...args: unknown[]): void {
    log("debug", "\u001b[36mDEBUG\u001b[0m", namespace, scope, ...args);
  },
  info(namespace: string, scope: string, ...args: unknown[]): void {
    log("info", "\u001b[1m\u001b[34mINFO \u001b[0m", namespace, scope, ...args);
  },
  warn(namespace: string, scope: string, ...args: unknown[]): void {
    log("warn", "\u001b[1m\u001b[33mWARN \u001b[0m", namespace, scope, ...args);
  },
  error(namespace: string, scope: string, ...args: unknown[]): void {
    log("error", "\u001b[1m\u001b[31mERROR\u001b[0m", namespace, scope, ...args);
  },
};
