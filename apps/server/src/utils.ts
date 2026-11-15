/** Address the server listens on, so only this machine reaches it. */
export const LISTEN_ADDRESS = "127.0.0.1";

const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Removes the terminal escape sequences of output, such as colors.
 * @param text The output.
 * @returns The plain text.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE, "");
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeDeep(target: Record<string, unknown>, ...sources: Record<string, unknown>[]): Record<string, unknown> {
  if (!sources.length) {
    return target;
  }

  const source = sources.shift();
  if (!source) {
    return target;
  }

  if (isObject(target) && isObject(source)) {
    for (const key of Object.keys(source)) {
      const sourceValue = source[key];
      const targetValue = target[key];

      if (isObject(sourceValue)) {
        if (!isObject(targetValue)) {
          target[key] = {};
        }

        mergeDeep(target[key] as Record<string, unknown>, sourceValue);
      } else {
        target[key] = sourceValue;
      }
    }
  }

  return mergeDeep(target, ...sources);
}

export function toRecord(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

export function toStringRecord(value: unknown): Record<string, string> | null {
  const readRecord = (record: Record<string, unknown>, output: Record<string, string>): boolean => {
    for (const [key, item] of Object.entries(record)) {
      if (typeof item !== "string") {
        return false;
      }
      output[key] = item;
    }
    return true;
  };

  if (isObject(value)) {
    const output: Record<string, string> = {};
    if (!readRecord(value, output)) {
      return null;
    }
    return output;
  }

  if (Array.isArray(value)) {
    const output: Record<string, string> = {};
    for (const item of value) {
      if (!isObject(item)) {
        return null;
      }
      if (!readRecord(item, output)) {
        return null;
      }
    }
    return output;
  }

  return null;
}

export function toStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value;
}

export function toCommandArgsArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const args: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      args.push(item);
      continue;
    }

    if (typeof item === "number" && Number.isFinite(item)) {
      args.push(String(item));
      continue;
    }

    return null;
  }

  return args;
}

export function toIntegerArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const numbers: number[] = [];
  for (const item of value) {
    if (!Number.isInteger(item) || item <= 0) {
      return null;
    }
    numbers.push(item);
  }

  return numbers;
}
