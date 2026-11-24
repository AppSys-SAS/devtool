import { type FSWatcher, watch } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/server'
import { type SkillCatalog, type SkillFileEntry, type SkillFiles, SkillsExtension } from '@modelcontextprotocol/server/ext/skills'
import { logger } from '@appsys/devtool-shared'

const RELOAD_DELAY_MS = 300

/** A folder of agent skills served to the agents. */
export interface SkillFolder {
  /** Where its skills appear in the catalog, as `/`-separated segments. */
  prefix: string
  /** The folder holding one skill per folder at its root. */
  folder: string
  /** Globs of the names of the skill folders served. */
  include: readonly string[]
}

/**
 * Tells whether a folder serves a skill.
 * @param source The folder.
 * @param name The name of the skill folder.
 * @returns True when one of its globs matches the name.
 */
function serves (source: SkillFolder, name: string): boolean {
  return source.include.some(glob => path.matchesGlob(name, glob))
}

/**
 * Lists a folder of the disk, symbolic links followed.
 * @param folder The folder.
 * @returns Its children, none when it does not exist.
 */
async function listFolder (folder: string): Promise<SkillFileEntry[]> {
  const dirents = await fs.readdir(folder, { withFileTypes: true }).catch(() => [])
  return Promise.all(dirents.map(async (dirent): Promise<SkillFileEntry> => {
    const stat = dirent.isSymbolicLink() ? await fs.stat(path.join(folder, dirent.name)).catch(() => null) : dirent
    return { name: dirent.name, kind: stat?.isDirectory() ? 'directory' : stat?.isFile() ? 'file' : 'unsupported' }
  }))
}

/**
 * Gives the storage of a skills catalog joining folders of skills under their prefixes, each showing
 * only the skill folders it serves.
 * @param folders Gives the folders, read again on every access.
 * @returns The storage.
 */
export function joinedSkillFiles (folders: () => readonly SkillFolder[]): SkillFiles {
  const locate = (relative: string): { source: SkillFolder, rest: string[] }[] => {
    const parts = relative === '' ? [] : relative.split('/')
    return folders().flatMap(source => {
      const prefix = source.prefix.split('/')
      const rest = parts.slice(prefix.length)
      return prefix.every((segment, index) => parts[index] === segment) && !rest.some(part => part === '..' || part === '.') ? [{ source, rest }] : []
    })
  }

  return {
    async list (dir) {
      const parts = dir === '' ? [] : dir.split('/')
      const entries = new Map<string, SkillFileEntry>()
      for (const source of folders()) {
        const prefix = source.prefix.split('/')
        if (parts.length < prefix.length && parts.every((part, index) => prefix[index] === part)) {
          entries.set(prefix[parts.length], { name: prefix[parts.length], kind: 'directory' })
        }
      }
      for (const { source, rest } of locate(dir)) {
        if (rest.length > 0 && !serves(source, rest[0])) {
          continue
        }
        for (const entry of await listFolder(path.join(source.folder, ...rest))) {
          if (rest.length > 0 || (entry.kind === 'directory' && serves(source, entry.name))) {
            entries.set(entry.name, entry)
          }
        }
      }
      return [...entries.values()]
    },
    async read (file) {
      const found = locate(file).find(({ source, rest }) => rest.length > 1 && serves(source, rest[0]))
      if (!found) {
        throw new Error(`${file} is not a file of a served skill`)
      }
      return fs.readFile(path.join(found.source.folder, ...found.rest))
    }
  }
}

/**
 * The agent skills served to the agents through the Skills extension of MCP, read again whenever a
 * file of their folders changes.
 */
export class DevtoolSkills {
  private _folders: SkillFolder[] = []

  private _catalog: SkillCatalog | null = null

  private _watchers: FSWatcher[] = []

  private _reload: ReturnType<typeof setTimeout> | null = null

  /**
   * Serves the skills of new folders.
   * @param folders The folders, none to serve no skill.
   */
  async configure (folders: SkillFolder[]): Promise<void> {
    this._folders = folders
    for (const watcher of this._watchers) {
      watcher.close()
    }
    this._watchers = folders.flatMap(({ folder }) => {
      try {
        return [watch(folder, { recursive: true }, () => this.scheduleReload()).on('error', () => undefined)]
      } catch {
        return []
      }
    })
    if (this._catalog) {
      await this.reload()
    } else if (folders.length > 0) {
      this._catalog = await SkillsExtension.load(joinedSkillFiles(() => this._folders), {
        onWarning: warning => logger.warn('MCP', 'Skills', `${warning.path}: ${warning.message}`)
      })
    }
  }

  /**
   * Serves the skills on the server of a session, when some are served.
   * @param server The server, not connected yet.
   */
  attach (server: McpServer): void {
    if (this._catalog && this._folders.length > 0) {
      this._catalog.attach(server)
    }
  }

  /**
   * Reads the skills again shortly after a change, a burst of changes reading them once.
   */
  private scheduleReload (): void {
    if (this._reload) {
      clearTimeout(this._reload)
    }
    this._reload = setTimeout(() => {
      this._reload = null
      void this.reload()
    }, RELOAD_DELAY_MS)
  }

  /**
   * Reads the skills again, the agents told when the list changed.
   */
  private async reload (): Promise<void> {
    try {
      await this._catalog?.reload()
    } catch (error) {
      logger.warn('MCP', 'Skills', error instanceof Error ? error.message : String(error))
    }
  }
}
