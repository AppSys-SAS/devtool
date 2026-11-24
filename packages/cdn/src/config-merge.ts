import { isDeepStrictEqual } from 'node:util'
import { parseDocument } from 'yaml'

/** A key whose value differs between two copies of a configuration file; `undefined` stands for an absent key. */
export interface KeyDifference {
  path: string[]
  local: unknown
  remote: unknown
}

/** The copy whose value a key takes. */
export type CopySide = 'local' | 'remote'

/** The value chosen for a differing key. */
export interface KeyChoice {
  path: string[]
  side: CopySide
}

/** The new value of a key, `undefined` to remove it. */
interface KeyChange {
  path: string[]
  value: unknown
}

/** How a configuration file format is read as a map and changed key by key, keeping its layout. */
export interface ConfigFormat {
  read(text: string, label: string): Record<string, unknown>
  write(baseText: string, changes: KeyChange[]): string
}

const DOTENV_LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/
const DOTENV_PLAIN_VALUE = /^[\w./:@,+=-]*$/

/**
 * Tells whether a value is a map.
 *
 * @param value - The value.
 * @returns True for a map.
 */
function isMap (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads a YAML file.
 *
 * @param text - The YAML text.
 * @param label - Names the file in errors.
 * @returns Its value.
 */
export function readYaml (text: string, label: string): unknown {
  const document = parseDocument(text)
  if (document.errors.length > 0) {
    throw new Error(`${label} is not valid YAML: ${document.errors[0].message}`)
  }

  return document.toJS()
}

/**
 * Reads a YAML file whose root is a map.
 *
 * @param text - The YAML text.
 * @param label - Names the file in errors.
 * @returns The map, empty for an empty file.
 */
export function readMap (text: string, label: string): Record<string, unknown> {
  const value = readYaml(text, label)
  if (value === null || value === undefined) {
    return {}
  }

  if (!isMap(value)) {
    throw new Error(`${label} is not a YAML map`)
  }

  return value
}

/**
 * Sets or removes the value at a path of a map, creating the missing maps on the way.
 *
 * @param root - The map.
 * @param change - The key and its new value.
 */
function applyChange (root: Record<string, unknown>, change: KeyChange): void {
  const parents = change.path.slice(0, -1)
  const key = change.path[change.path.length - 1]
  let current = root
  for (const part of parents) {
    if (!isMap(current[part])) {
      if (change.value === undefined) {
        return
      }
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }

  if (change.value === undefined) {
    delete current[key]
  } else {
    current[key] = change.value
  }
}

/**
 * Reads the value of a line of a dotenv file: quoted with escapes, single-quoted as is, or bare
 * without its trailing comment, a hash preceded by a blank.
 *
 * @param raw - The text after the equal sign, with its surrounding blanks.
 * @returns The value.
 */
function readDotenvValue (raw: string): string {
  const text = raw.trim()
  if (text.startsWith('\'')) {
    const end = text.indexOf('\'', 1)
    return text.slice(1, end === -1 ? undefined : end)
  }
  if (!text.startsWith('"')) {
    return raw.replace(/\s#.*$/, '').trim()
  }

  let value = ''
  for (let index = 1; index < text.length && text[index] !== '"'; index += 1) {
    if (text[index] === '\\' && index + 1 < text.length) {
      index += 1
      value += text[index] === 'n' ? '\n' : text[index]
    } else {
      value += text[index]
    }
  }
  return value
}

/**
 * Writes a value for a dotenv file, quoted when it holds anything but plain characters.
 *
 * @param value - The value.
 * @returns Its text after the equal sign.
 */
function formatDotenvValue (value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return DOTENV_PLAIN_VALUE.test(text) ? text : `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

const YAML_FORMAT: ConfigFormat = {
  read: readMap,
  /**
   * Changes the keys of a YAML file in place, keeping its comments and the layout of its collections.
   *
   * @param baseText - The YAML text.
   * @param changes - The new value of each key, `undefined` to remove it.
   * @returns The new text.
   */
  write (baseText, changes) {
    const document = parseDocument(baseText)
    for (const change of changes) {
      if (change.value === undefined) {
        document.deleteIn(change.path)
      } else {
        document.setIn(change.path, change.value)
      }
    }
    return document.toString({ lineWidth: 0, flowCollectionPadding: false })
  }
}

const JSON_FORMAT: ConfigFormat = {
  read (text, label) {
    let value: unknown
    try {
      value = text.trim() ? JSON.parse(text) : {}
    } catch (error) {
      throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    if (!isMap(value)) {
      throw new Error(`${label} is not a JSON object`)
    }
    return value
  },
  write (baseText, changes) {
    const root = JSON_FORMAT.read(baseText, 'the file')
    for (const change of changes) {
      applyChange(root, change)
    }
    const indent = /^[ \t]+(?=")/m.exec(baseText)?.[0] ?? '  '
    return `${JSON.stringify(root, null, indent)}${baseText.endsWith('\n') ? '\n' : ''}`
  }
}

const DOTENV_FORMAT: ConfigFormat = {
  read (text) {
    const values: Record<string, unknown> = {}
    for (const line of text.split(/\r?\n/)) {
      const match = DOTENV_LINE.exec(line)
      if (match) {
        values[match[2]] = readDotenvValue(match[3])
      }
    }
    return values
  },
  /**
   * Changes the keys of a dotenv file in place, keeping its other lines and its line ending. A key
   * declared several times takes its new value on its last line, the one read, and is removed
   * from every line; new keys are added at the end.
   *
   * @param baseText - The dotenv text.
   * @param changes - The new value of each key, `undefined` to remove it.
   * @returns The new text.
   */
  write (baseText, changes) {
    const pending = new Map(changes.map(change => [change.path[0], change.value]))
    const baseLines = baseText.split(/\r?\n/)
    const matches = baseLines.map(line => DOTENV_LINE.exec(line))
    const lastLines = new Map<string, number>()
    for (const [index, match] of matches.entries()) {
      if (match) {
        lastLines.set(match[2], index)
      }
    }

    const lines: string[] = []
    for (const [index, line] of baseLines.entries()) {
      const match = matches[index]
      if (!match || !pending.has(match[2])) {
        lines.push(line)
        continue
      }

      const value = pending.get(match[2])
      if (value !== undefined) {
        lines.push(lastLines.get(match[2]) === index ? `${match[1]}${match[2]}=${formatDotenvValue(value)}` : line)
      }
    }

    const added = [...pending].filter(([key, value]) => value !== undefined && !lastLines.has(key)).map(([key, value]) => `${key}=${formatDotenvValue(value)}`)
    const end = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
    lines.splice(end, 0, ...added)
    return lines.join(/\r?\n/.exec(baseText)?.[0] ?? '\n')
  }
}

const FORMATS: [RegExp, ConfigFormat][] = [
  [/\.ya?ml$/, YAML_FORMAT],
  [/\.json$/, JSON_FORMAT],
  [/\.env$/, DOTENV_FORMAT]
]

/**
 * Gives the format of a configuration file whose keys can be compared and merged.
 *
 * @param filePath - The path of the file.
 * @returns Its format, null when its keys cannot be merged.
 */
export function configFormatOf (filePath: string): ConfigFormat | null {
  return FORMATS.find(([pattern]) => pattern.test(filePath))?.[1] ?? null
}

/**
 * Lists the keys whose values differ between two copies of a configuration file, comparing maps
 * key by key and any other value (lists, scalars) as a whole.
 *
 * @param format - The format of the file.
 * @param localText - The local copy.
 * @param remoteText - The CDN copy.
 * @returns The differences, in the order of the keys.
 */
export function diffConfig (format: ConfigFormat, localText: string, remoteText: string): KeyDifference[] {
  const differences: KeyDifference[] = []
  const walk = (local: Record<string, unknown>, remote: Record<string, unknown>, path: string[]): void => {
    for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      const localValue = Object.hasOwn(local, key) ? local[key] : undefined
      const remoteValue = Object.hasOwn(remote, key) ? remote[key] : undefined
      if (isMap(localValue) && isMap(remoteValue)) {
        walk(localValue, remoteValue, [...path, key])
      } else if (!isDeepStrictEqual(localValue, remoteValue)) {
        differences.push({ path: [...path, key], local: localValue, remote: remoteValue })
      }
    }
  }

  walk(format.read(localText, 'the local copy'), format.read(remoteText, 'the CDN copy'), [])
  return differences
}

/**
 * Applies the chosen values of the differing keys to one of the two copies, keeping its layout.
 * Keys without a choice keep the value of that copy.
 *
 * @param format - The format of the file.
 * @param baseText - The copy the result is built from.
 * @param baseSide - Which copy it is.
 * @param differences - The differing keys of the two copies.
 * @param choices - The value chosen for each key.
 * @returns The merged text.
 */
export function mergeConfig (format: ConfigFormat, baseText: string, baseSide: CopySide, differences: KeyDifference[], choices: KeyChoice[]): string {
  const chosen = new Map(choices.map(choice => [JSON.stringify(choice.path), choice.side]))
  const changes = differences
    .filter(difference => (chosen.get(JSON.stringify(difference.path)) ?? baseSide) !== baseSide)
    .map(difference => ({ path: difference.path, value: baseSide === 'local' ? difference.remote : difference.local }))
  return format.write(baseText, changes)
}

/**
 * Counts how many differing keys take each copy's value.
 *
 * @param differences - The differing keys.
 * @param choices - The value chosen for each key.
 * @param baseSide - The copy the keys without a choice keep.
 * @returns The number of keys taking the local and the CDN values.
 */
export function countChoices (differences: KeyDifference[], choices: KeyChoice[], baseSide: CopySide): Record<CopySide, number> {
  const chosen = new Map(choices.map(choice => [JSON.stringify(choice.path), choice.side]))
  const counts: Record<CopySide, number> = { local: 0, remote: 0 }
  for (const difference of differences) {
    counts[chosen.get(JSON.stringify(difference.path)) ?? baseSide] += 1
  }

  return counts
}
