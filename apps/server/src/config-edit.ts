import fs from 'node:fs/promises'
import path from 'node:path'
import { isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml'
import { isMcpFilesSetting, mcpLevelsFor, mcpLevelsOf, type McpAction, type McpLevel } from '@appsys/devtool-shared'

/** The levels of the settings being a level themselves, by their last key. */
const LEVEL_SETTINGS: Record<string, McpLevel[]> = {
  ownTerminals: ['allow', 'ask'],
  level: ['allow', 'ask', 'deny']
}

/**
 * Tells whether a level fits a setting: one an action accepts in an `mcp` setting, or one a setting
 * being a level itself accepts.
 * @param settingPath The keys leading to the setting.
 * @param action The action changed, null for a setting being a level itself.
 * @param level The level.
 * @returns True when the level may be written.
 */
export function acceptsMcpLevel (settingPath: string[], action: McpAction | null, level: McpLevel): boolean {
  if (action !== null) {
    return settingPath.at(-1) !== 'ownTerminals' && settingPath.at(-1) !== 'level' && mcpLevelsFor(action, isMcpFilesSetting(settingPath)).includes(level)
  }
  return LEVEL_SETTINGS[settingPath.at(-1) ?? '']?.includes(level) ?? false
}

/**
 * Turns the keys leading to a setting into the keys of a YAML document, list indexes as numbers.
 * @param settingPath The keys, list indexes as text.
 * @returns The keys of the document.
 */
function documentPath (settingPath: string[]): (string | number)[] {
  return settingPath.map(key => (/^\d+$/.test(key) ? Number(key) : key))
}

/**
 * Makes the lists leading to a setting long enough to hold it, the items added being empty maps,
 * which change nothing once the configuration files are merged, and turns an item written as a text
 * into its long form `{ path }` so that it can hold the setting.
 * @param document The YAML document.
 * @param keys The keys leading to the setting.
 */
function ensureLists (document: Document, keys: (string | number)[]): void {
  keys.forEach((key, position) => {
    if (typeof key !== 'number') {
      return
    }
    const parent = keys.slice(0, position)
    const list = document.getIn(parent)
    if (!isSeq(list)) {
      document.setIn(parent, document.createNode(Array.from({ length: key + 1 }, () => ({}))))
      return
    }
    while (list.items.length <= key) {
      list.add(document.createNode({}))
    }
    const item = list.get(key, true)
    if (isScalar(item) && typeof item.value === 'string') {
      list.set(key, document.createNode({ path: item.value }))
    }
  })
}

/**
 * Removes a setting, then the maps it leaves empty above it, up to the first list item, whose position
 * matters once the configuration files are merged.
 * @param document The YAML document.
 * @param keys The keys leading to the setting.
 */
function removeSetting (document: Document, keys: (string | number)[]): void {
  document.deleteIn(keys)
  for (let length = keys.length - 1; length > 0 && typeof keys[length - 1] === 'string'; length -= 1) {
    const holder = document.getIn(keys.slice(0, length))
    if (!isMap(holder) || holder.items.length) {
      return
    }
    document.deleteIn(keys.slice(0, length))
  }
}

/**
 * Sets or removes the level of an action in an `mcp` setting of a YAML configuration file, keeping its
 * comments and layout. A setting giving one level to every action is turned into levels by action first;
 * a setting left without level is removed.
 * @param file The configuration file, created when missing.
 * @param settingPath The keys leading to the `mcp` setting, or to a level of its own.
 * @param action The action changed, null for a setting being a level itself.
 * @param level The new level, null to remove it so that it is inherited.
 */
export async function writeMcpLevel (file: string, settingPath: string[], action: McpAction | null, level: McpLevel | null): Promise<void> {
  if (action === null) {
    await writeSetting(file, settingPath, level)
    return
  }
  await editConfigFile(file, document => {
    const keys = documentPath(settingPath)
    const current = document.getIn(keys)
    const declared = mcpLevelsOf(isMap(current) ? current.toJSON() : current, isMcpFilesSetting(settingPath)).levels
    const next = { ...declared, [action]: level ?? undefined }
    const remaining = Object.entries(next).filter(([, value]) => value !== undefined)
    if (!remaining.length) {
      removeSetting(document, keys)
    } else if (isMap(current)) {
      if (level === null) {
        document.deleteIn([...keys, action])
      } else {
        document.setIn([...keys, action], level)
      }
    } else {
      ensureLists(document, keys)
      document.setIn(keys, document.createNode(Object.fromEntries(remaining)))
    }
  })
}

/**
 * Sets or removes a setting of a YAML configuration file, keeping its comments and layout; a list is
 * written on one line.
 * @param file The configuration file, created when missing.
 * @param settingPath The keys leading to the setting.
 * @param value The new value, null to remove the setting.
 */
export async function writeSetting (file: string, settingPath: string[], value: unknown): Promise<void> {
  await editConfigFile(file, document => {
    const keys = documentPath(settingPath)
    if (value === null) {
      removeSetting(document, keys)
      return
    }
    ensureLists(document, keys)
    const node = document.createNode(value)
    if (isSeq(node)) {
      node.flow = true
    }
    document.setIn(keys, node)
  })
}

/**
 * Changes a YAML configuration file through its document, keeping its comments and layout.
 * @param file The configuration file, created when missing.
 * @param edit Changes the document.
 */
async function editConfigFile (file: string, edit: (document: Document) => void): Promise<void> {
  const text = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return ''
    }
    throw error
  })
  const document = parseDocument(text)
  edit(document)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, document.toString({ lineWidth: 0 }))
}
