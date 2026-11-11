import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";

/** A key whose value differs between two YAML files; `undefined` stands for an absent key. */
export interface YamlDifference {
  path: string[];
  local: unknown;
  remote: unknown;
}

/** The copy whose value a key takes. */
export type YamlSide = "local" | "remote";

/** The value chosen for a differing key. */
export interface YamlKeyChoice {
  path: string[];
  side: YamlSide;
}

/**
 * Tells whether a value is a YAML map.
 *
 * @param value - The value.
 * @returns True for a map.
 */
function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a YAML file whose root is a map.
 *
 * @param text - The YAML text.
 * @param label - Names the file in errors.
 * @returns The map, empty for an empty file.
 */
export function readMap(text: string, label: string): Record<string, unknown> {
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    throw new Error(`${label} is not valid YAML: ${document.errors[0].message}`);
  }

  const value: unknown = document.toJS();
  if (value === null || value === undefined) {
    return {};
  }

  if (!isMap(value)) {
    throw new Error(`${label} is not a YAML map`);
  }

  return value;
}

/**
 * Lists the keys whose values differ between two YAML files, comparing maps key by key and any
 * other value (lists, scalars) as a whole.
 *
 * @param localText - The local copy.
 * @param remoteText - The CDN copy.
 * @returns The differences, in the order of the keys.
 */
export function diffYaml(localText: string, remoteText: string): YamlDifference[] {
  const differences: YamlDifference[] = [];
  const walk = (local: Record<string, unknown>, remote: Record<string, unknown>, path: string[]): void => {
    for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      const localValue = Object.hasOwn(local, key) ? local[key] : undefined;
      const remoteValue = Object.hasOwn(remote, key) ? remote[key] : undefined;
      if (isMap(localValue) && isMap(remoteValue)) {
        walk(localValue, remoteValue, [...path, key]);
      } else if (!isDeepStrictEqual(localValue, remoteValue)) {
        differences.push({ path: [...path, key], local: localValue, remote: remoteValue });
      }
    }
  };

  walk(readMap(localText, "the local copy"), readMap(remoteText, "the CDN copy"), []);
  return differences;
}

/**
 * Applies the chosen values of the differing keys to one of the two copies, keeping its comments
 * and layout. Keys without a choice keep the value of that copy.
 *
 * @param baseText - The copy the result is built from.
 * @param baseSide - Which copy it is.
 * @param differences - The differing keys of the two copies.
 * @param choices - The value chosen for each key.
 * @returns The merged YAML text.
 */
export function mergeYaml(baseText: string, baseSide: YamlSide, differences: YamlDifference[], choices: YamlKeyChoice[]): string {
  const document = parseDocument(baseText);
  const chosen = new Map(choices.map((choice) => [JSON.stringify(choice.path), choice.side]));
  for (const difference of differences) {
    const side = chosen.get(JSON.stringify(difference.path)) ?? baseSide;
    if (side === baseSide) {
      continue;
    }

    const value = side === "local" ? difference.local : difference.remote;
    if (value === undefined) {
      document.deleteIn(difference.path);
    } else {
      document.setIn(difference.path, value);
    }
  }

  return document.toString({ lineWidth: 0 });
}

/**
 * Counts how many differing keys take each copy's value.
 *
 * @param differences - The differing keys.
 * @param choices - The value chosen for each key.
 * @param baseSide - The copy the keys without a choice keep.
 * @returns The number of keys taking the local and the CDN values.
 */
export function countChoices(differences: YamlDifference[], choices: YamlKeyChoice[], baseSide: YamlSide): Record<YamlSide, number> {
  const chosen = new Map(choices.map((choice) => [JSON.stringify(choice.path), choice.side]));
  const counts: Record<YamlSide, number> = { local: 0, remote: 0 };
  for (const difference of differences) {
    counts[chosen.get(JSON.stringify(difference.path)) ?? baseSide] += 1;
  }

  return counts;
}
