import { isUtf8 } from 'node:buffer'
import fs from 'node:fs/promises'
import path from 'node:path'
import { defaultEnvironmentFolder, readEnvironmentOptions, readYaml, readYamlMap, SHARED_CONFIG_PATH, writeLocalFile } from '@appsys/devtool-cdn'
import type { RawConfig } from '@appsys/devtool-config'
import { AGENT_SKILL_FILE, agentSkillFolderOf, type AgentSkillSummary, type FileEntryPayload, type FilePayload, type FileTreePayload, newAgentSkill, type ProjectDefinition, readAgentSkill } from '@appsys/devtool-shared'

/** Identifier of the file space of the configuration files of the development environment. */
export const CONFIGS_SPACE = 'configs'

const YAML_EXTENSION = /\.ya?ml$/
const LOCAL_YAML_EXTENSION = /\.local\.ya?ml$/

/**
 * Describes an error for the interface.
 *
 * @param error - The error.
 * @returns Its message.
 */
function messageOf (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Gives the personal override of a YAML configuration file, next to it and never synchronized.
 *
 * @param filePath - The path of the file, such as `account/config.yml`.
 * @returns The path of its override, such as `account/config.local.yml`, or null for a file that is not YAML or is an override itself.
 */
function localOverrideOf (filePath: string): string | null {
  return YAML_EXTENSION.test(filePath) && !LOCAL_YAML_EXTENSION.test(filePath) ? filePath.replace(YAML_EXTENSION, '.local.yml') : null
}

/**
 * Lists the configuration files of the environment the configurations tab shows, sorted, each followed by its
 * personal override unless its `local` is false.
 *
 * @param section - The raw `environment` section of the configuration.
 * @returns The folder of the environment and the paths of the files in it, the shared devtool configuration alone
 * in the default folder when the section is missing or invalid.
 */
function configFiles (section: unknown): { folder: string, paths: string[] } {
  const sharedConfig = { path: SHARED_CONFIG_PATH, display: true, local: true }
  let folder = defaultEnvironmentFolder()
  let files = [sharedConfig]
  try {
    const options = readEnvironmentOptions(section)
    folder = options?.folder ?? folder
    files = options?.configFiles.filter(file => file.display) ?? files
  } catch {
    files = [sharedConfig]
  }

  const paths = [...files].sort((left, right) => left.path.localeCompare(right.path)).flatMap(file => [file.path, file.local ? localOverrideOf(file.path) : null])
  return { folder, paths: [...new Set(paths.filter(filePath => filePath !== null))] }
}

/**
 * A folder of files the interface reads and writes, every path relative to its root. Hidden files,
 * parent segments and symbolic links are out of reach; binary files are reported, never sent.
 */
export abstract class FileSpace {
  /**
   * @param id - Identifier of the space.
   * @param root - Absolute path of its root.
   * @param editable - Whether files and folders can be created, renamed and removed.
   * @param afterWrite - Runs once a file of the space is written.
   */
  constructor (
    readonly id: string,
    readonly root: string,
    readonly editable: boolean,
    readonly afterWrite: ((filePath: string) => Promise<void>) | null = null
  ) {}

  /**
   * Lists the files and folders of the space, the root existing.
   *
   * @returns The entries.
   */
  protected abstract entries (): Promise<FileEntryPayload[]>

  /**
   * Checks the content about to be written to a file.
   *
   * @param filePath - The path of the file.
   * @param content - The content.
   */
  protected abstract validate (filePath: string, content: string): void

  /**
   * Describes the files of the space.
   *
   * @returns The files, with why they could not be listed, if they could not.
   */
  async tree (): Promise<FileTreePayload> {
    const payload: FileTreePayload = { space: this.id, root: this.root, exists: false, editable: this.editable, entries: [], agentSkills: null, error: null }
    try {
      const stat = await fs.stat(this.root)
      if (!stat.isDirectory()) {
        return { ...payload, error: `${this.root} is not a folder` }
      }
      return { ...payload, exists: true, entries: await this.entries() }
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? payload : { ...payload, error: messageOf(error) }
    }
  }

  /**
   * Reads a file.
   *
   * @param filePath - The path of the file.
   * @returns The file, with why it could not be read, if it could not.
   */
  async read (filePath: string): Promise<FilePayload> {
    const payload: FilePayload = { space: this.id, path: filePath, content: null, binary: false, updatedAt: null, saved: false, conflict: false, error: null }
    try {
      const absolutePath = await this.resolve(filePath)
      const stat = await fs.lstat(absolutePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return null
        }
        throw error
      })
      if (!stat) {
        return payload
      }
      if (!stat.isFile()) {
        return { ...payload, error: `${filePath} is not a file` }
      }

      const buffer = await fs.readFile(absolutePath)
      const updatedAt = stat.mtime.toISOString()
      return buffer.includes(0) || !isUtf8(buffer) ? { ...payload, binary: true, updatedAt } : { ...payload, content: buffer.toString('utf-8'), updatedAt }
    } catch (error) {
      return { ...payload, error: messageOf(error) }
    }
  }

  /**
   * Replaces a file, unless it changed since it was read, it is binary or its content is refused.
   *
   * @param filePath - The path of the file.
   * @param content - The new content.
   * @param baseUpdatedAt - Last change of the file the content was edited from, null when it did not exist.
   * @returns The file as it now stands, with whether it was replaced and why not.
   */
  async write (filePath: string, content: string, baseUpdatedAt: string | null): Promise<FilePayload> {
    const current = await this.read(filePath)
    if (current.error) {
      return current
    }
    if (current.binary) {
      return { ...current, error: `${filePath} holds binary data` }
    }
    if (current.updatedAt !== baseUpdatedAt) {
      return { ...current, conflict: true, error: `${filePath} changed on disk since it was opened` }
    }

    try {
      this.validate(filePath, content)
      await writeLocalFile(await this.resolve(filePath), content)
    } catch (error) {
      return { ...current, error: messageOf(error) }
    }

    return { ...(await this.read(filePath)), saved: true }
  }

  /**
   * Creates an empty file, or a folder, readable by the current user only.
   *
   * @param filePath - The path of the file or folder.
   * @param kind - Whether a file or a folder is created.
   */
  async create (filePath: string, kind: FileEntryPayload['kind']): Promise<void> {
    const absolutePath = await this.resolveEditable(filePath)
    if (kind === 'directory') {
      await fs.mkdir(absolutePath, { recursive: true, mode: 0o700 })
      return
    }

    await fs.mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 })
    await fs.writeFile(absolutePath, '', { flag: 'wx', mode: 0o600 })
  }

  /**
   * Removes a file, or a folder with everything it holds.
   *
   * @param filePath - The path of the file or folder.
   */
  async remove (filePath: string): Promise<void> {
    await fs.rm(await this.resolveEditable(filePath), { recursive: true })
  }

  /**
   * Renames or moves a file or folder inside the space.
   *
   * @param from - Its current path.
   * @param to - Its new path, which must not exist.
   */
  async rename (from: string, to: string): Promise<void> {
    const source = await this.resolveEditable(from)
    const target = await this.resolveEditable(to)
    if (await fs.lstat(target).then(() => true, () => false)) {
      throw new Error(`${to} already exists`)
    }

    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await fs.rename(source, target)
  }

  /**
   * Gives the absolute path of a path of the space, refusing anything outside of it: absolute paths,
   * parent, current or hidden segments, and symbolic links among the existing segments.
   *
   * @param filePath - The path, relative to the root.
   * @returns The absolute path.
   */
  protected async resolve (filePath: string): Promise<string> {
    const segments = filePath.split('/')
    if (!filePath || path.isAbsolute(filePath) || segments.some(segment => !segment || segment.startsWith('.') || segment.includes('\\') || segment.includes('\0'))) {
      throw new Error(`${filePath} is not a path of ${this.id}`)
    }

    let current = this.root
    for (const segment of segments) {
      current = path.join(current, segment)
      const stat = await fs.lstat(current).catch(() => null)
      if (!stat) {
        break
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`${filePath} goes through a symbolic link`)
      }
    }
    return path.join(this.root, filePath)
  }

  /**
   * Gives the absolute path of a path of the space whose files and folders can be changed.
   *
   * @param filePath - The path, relative to the root.
   * @returns The absolute path.
   */
  private async resolveEditable (filePath: string): Promise<string> {
    if (!this.editable) {
      throw new Error(`files of ${this.id} cannot be created, renamed or removed`)
    }
    return this.resolve(filePath)
  }
}

/**
 * A file space made of a fixed list of YAML files whose root is a map.
 */
export class ListedFileSpace extends FileSpace {
  /**
   * @param id - Identifier of the space.
   * @param root - Absolute path of its root.
   * @param paths - The paths of its files, which may not exist.
   * @param afterWrite - Runs once a file of the space is written.
   */
  constructor (
    id: string,
    root: string,
    private readonly _paths: string[],
    afterWrite: ((filePath: string) => Promise<void>) | null = null
  ) {
    super(id, root, false, afterWrite)
  }

  /**
   * Lists the files of the space.
   *
   * @returns The files, existing or not.
   */
  protected async entries (): Promise<FileEntryPayload[]> {
    return this._paths.map(filePath => ({ path: filePath, kind: 'file' }))
  }

  /**
   * Checks that the content of a YAML file is a map.
   *
   * @param filePath - The path of the file.
   * @param content - The content.
   */
  protected validate (filePath: string, content: string): void {
    if (YAML_EXTENSION.test(filePath)) {
      readYamlMap(content, filePath)
    }
  }

  /**
   * Gives the absolute path of a file of the list.
   *
   * @param filePath - The path of the file.
   * @returns The absolute path.
   */
  protected async resolve (filePath: string): Promise<string> {
    if (!this._paths.includes(filePath)) {
      throw new Error(`${filePath} is not a file of ${this.id}`)
    }
    return super.resolve(filePath)
  }
}

/**
 * A file space made of everything its root holds, whose files and folders can be changed.
 */
export class TreeFileSpace extends FileSpace {
  /**
   * @param id - Identifier of the space.
   * @param root - Absolute path of its root.
   */
  constructor (id: string, root: string) {
    super(id, root, true)
  }

  /**
   * Lists the files and folders under the root, hidden ones and symbolic links left out.
   *
   * @returns The entries, sorted by path.
   */
  protected async entries (): Promise<FileEntryPayload[]> {
    const entries: FileEntryPayload[] = []
    const visit = async (folder: string): Promise<void> => {
      for (const dirent of await fs.readdir(path.join(this.root, folder), { withFileTypes: true })) {
        if (dirent.name.startsWith('.') || dirent.isSymbolicLink()) {
          continue
        }

        const entryPath = folder ? `${folder}/${dirent.name}` : dirent.name
        if (dirent.isDirectory()) {
          entries.push({ path: entryPath, kind: 'directory' })
          await visit(entryPath)
        } else if (dirent.isFile()) {
          entries.push({ path: entryPath, kind: 'file' })
        }
      }
    }

    await visit('')
    return entries.sort((a, b) => a.path.localeCompare(b.path))
  }

  /**
   * Checks the syntax of a YAML file.
   *
   * @param filePath - The path of the file.
   * @param content - The content.
   */
  protected validate (filePath: string, content: string): void {
    if (YAML_EXTENSION.test(filePath)) {
      readYaml(content, filePath)
    }
  }
}

/**
 * A file space holding one agent skill per folder at its root, each described by the `SKILL.md` of its
 * folder, whatever the case of its name.
 */
export class AgentSkillsFileSpace extends TreeFileSpace {
  /**
   * Describes the files of the space and its skills.
   *
   * @returns The files and the skills, with why they could not be listed, if they could not.
   */
  override async tree (): Promise<FileTreePayload> {
    const tree = await super.tree()
    const skillFiles = new Map(
      tree.entries.flatMap(entry => {
        const folder = entry.kind === 'file' ? agentSkillFolderOf(entry.path) : null
        return folder ? [[folder, entry.path] as const] : []
      })
    )
    const folders = tree.entries.filter(entry => entry.kind === 'directory' && !entry.path.includes('/')).map(entry => entry.path)
    const agentSkills = await Promise.all(
      folders.map(async (folder): Promise<AgentSkillSummary> => {
        const skillFile = skillFiles.get(folder)
        const file = skillFile ? await this.read(skillFile) : null
        if (file === null || file.content === null) {
          return { folder, name: null, description: null, problems: [file?.error ?? `${AGENT_SKILL_FILE} is missing`] }
        }
        const { name, description, problems } = readAgentSkill(file.content, folder)
        return { folder, name, description, problems }
      })
    )
    return { ...tree, agentSkills }
  }

  /**
   * Refuses a `SKILL.md` whose header is not a YAML map, and checks the syntax of a YAML file.
   *
   * @param filePath - The path of the file.
   * @param content - The content.
   */
  protected override validate (filePath: string, content: string): void {
    super.validate(filePath, content)
    const folder = agentSkillFolderOf(filePath)
    const error = folder ? readAgentSkill(content, folder).error : null
    if (error) {
      throw new Error(`${filePath}: ${error}`)
    }
  }

  /**
   * Creates a file or a folder, a folder at the root being a new skill with its `SKILL.md`.
   *
   * @param filePath - The path of the file or folder.
   * @param kind - Whether a file or a folder is created.
   */
  override async create (filePath: string, kind: FileEntryPayload['kind']): Promise<void> {
    await super.create(filePath, kind)
    if (kind === 'directory' && !filePath.includes('/')) {
      await fs.writeFile(await this.resolve(`${filePath}/${AGENT_SKILL_FILE}`), newAgentSkill(filePath), { flag: 'wx', mode: 0o600 })
    }
  }
}

/**
 * The file spaces of the configuration: the configuration files of the development environment and
 * the folders of files declared by the directories of the projects.
 */
export class DevtoolFileSpaces {
  private _spaces = new Map<string, FileSpace>()

  /** The identifier of the space of the configuration files of the environment. */
  readonly configsSpace = CONFIGS_SPACE

  /**
   * Builds the spaces of a configuration.
   *
   * @param config - The raw configuration, for its `environment` section.
   * @param projects - The projects, for the folders of files of their directories.
   * @param afterConfigWrite - Runs once a configuration file is written.
   */
  configure (config: RawConfig, projects: Record<string, ProjectDefinition>, afterConfigWrite: (filePath: string) => Promise<void>): void {
    const { folder, paths } = configFiles(config.environment)
    const spaces = new Map<string, FileSpace>([[CONFIGS_SPACE, new ListedFileSpace(CONFIGS_SPACE, folder, paths, afterConfigWrite)]])
    for (const project of Object.values(projects)) {
      for (const directory of Object.values(project.directories)) {
        for (const files of Object.values(directory.files)) {
          const id = `${project.slug}/${directory.slug}/${files.slug}`
          spaces.set(id, files.type === 'agentSkills' ? new AgentSkillsFileSpace(id, files.path) : new TreeFileSpace(id, files.path))
        }
      }
    }
    this._spaces = spaces
  }

  /**
   * Finds a space.
   *
   * @param id - Its identifier.
   * @returns The space, or null when there is none.
   */
  get (id: string): FileSpace | null {
    return this._spaces.get(id) ?? null
  }

  /**
   * Tells whether a file of a space is the configuration of the devtool itself.
   *
   * @param spaceId - The identifier of the space.
   * @param filePath - The path of the file in the space.
   * @returns True for the shared or personal configuration of the devtool.
   */
  holdsDevtoolConfig (spaceId: string, filePath: string): boolean {
    return spaceId === CONFIGS_SPACE && isDevtoolConfig(filePath)
  }
}

/**
 * Tells whether a configuration file belongs to the devtool configuration.
 *
 * @param filePath - The path of the file in the configuration files space.
 * @returns True for the shared or personal devtool configuration.
 */
export function isDevtoolConfig (filePath: string): boolean {
  return filePath === SHARED_CONFIG_PATH || filePath === localOverrideOf(SHARED_CONFIG_PATH)
}
