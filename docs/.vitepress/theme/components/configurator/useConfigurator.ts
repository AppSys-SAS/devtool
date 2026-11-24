import { inject, provide, ref } from 'vue'
import type { InjectionKey, Ref } from 'vue'
import { asRecord } from './configFiles'

export type ConfigPath = readonly (string | number)[]

export interface ConfiguratorStore {
  config: Ref<Record<string, unknown>>
  get: (path: ConfigPath) => unknown
  set: (path: ConfigPath, value: unknown) => void
  add: (path: ConfigPath, base: string, value: Record<string, unknown>) => string
  rename: (path: ConfigPath, from: string, to: string) => void
  remove: (path: ConfigPath) => void
  replace: (config: Record<string, unknown>) => void
}

const ENTRY_MAPS = new Set(['sections', 'projects', 'commands', 'services', 'files', 'integrations', 'agents', 'loadBalancers', 'records'])
const configuratorKey: InjectionKey<ConfiguratorStore> = Symbol('configurator')

/**
 * Creates the configuration being edited and shares it with the forms below the calling component.
 * @param initial The configuration to start from.
 * @returns The store holding the configuration and its editing actions.
 */
export function provideConfigurator (initial: Record<string, unknown>): ConfiguratorStore {
  const config = ref<Record<string, unknown>>(structuredClone(initial))

  /**
   * Reads the value at a path.
   * @param path Keys from the root of the configuration.
   * @returns The value, undefined when a key along the path is missing.
   */
  const get = (path: ConfigPath): unknown => {
    let value: unknown = config.value
    for (const key of path) {
      if (typeof value !== 'object' || value === null) {
        return undefined
      }
      value = (value as Record<string | number, unknown>)[key]
    }
    return value
  }

  /**
   * Removes a key, then the objects left empty above it, keeping the entries of maps such as projects.
   * @param path Keys from the root of the configuration.
   */
  const remove = (path: ConfigPath): void => {
    for (let depth = path.length; depth > 0; depth--) {
      const parent = get(path.slice(0, depth - 1))
      if (typeof parent !== 'object' || parent === null) {
        return
      }
      const key = path[depth - 1]
      if (Array.isArray(parent) && typeof key === 'number') {
        parent.splice(key, 1)
      } else {
        Reflect.deleteProperty(parent, key)
      }
      const isEntry = depth >= 2 && ENTRY_MAPS.has(String(path[depth - 2]))
      if (depth === 1 || isEntry || Object.keys(parent).length > 0) {
        return
      }
    }
  }

  /**
   * Writes a value at a path, creating the objects along it; an empty value removes the key.
   * @param path Keys from the root of the configuration.
   * @param value The new value.
   */
  const set = (path: ConfigPath, value: unknown): void => {
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
      remove(path)
      return
    }
    let parent = config.value as Record<string | number, unknown>
    for (const key of path.slice(0, -1)) {
      if (typeof parent[key] !== 'object' || parent[key] === null) {
        parent[key] = {}
      }
      parent = parent[key] as Record<string | number, unknown>
    }
    parent[path[path.length - 1]] = value
  }

  /**
   * Adds an entry to a map under a free slug.
   * @param path Keys of the map, such as ['projects'].
   * @param base The slug to use, suffixed with a number when taken.
   * @param value The entry.
   * @returns The slug of the new entry.
   */
  const add = (path: ConfigPath, base: string, value: Record<string, unknown>): string => {
    const map = asRecord(get(path))
    let slug = base
    for (let index = 2; slug in map; index++) {
      slug = `${base}-${index}`
    }
    set([...path, slug], value)
    return slug
  }

  /**
   * Renames an entry of a map, keeping its position.
   * @param path Keys of the map.
   * @param from The current slug.
   * @param to The new slug, ignored when blank or taken.
   */
  const rename = (path: ConfigPath, from: string, to: string): void => {
    const map = asRecord(get(path))
    const slug = to.trim()
    if (!slug || slug === from || slug in map) {
      return
    }
    set(path, Object.fromEntries(Object.entries(map).map(([key, value]) => [key === from ? slug : key, value])))
  }

  /**
   * Replaces the whole configuration.
   * @param next The new configuration.
   */
  const replace = (next: Record<string, unknown>): void => {
    config.value = next
  }

  const store: ConfiguratorStore = { config, get, set, add, rename, remove, replace }
  provide(configuratorKey, store)
  return store
}

/**
 * Gives a form access to the configuration provided by the configurator.
 * @returns The store of the enclosing configurator.
 */
export function useConfigurator (): ConfiguratorStore {
  const store = inject(configuratorKey)
  if (!store) {
    throw new Error('useConfigurator needs a configurator above it')
  }
  return store
}
