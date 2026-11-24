import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** A folder some coding agents load their skills from. */
export interface AgentSkillFolder {
  /** Who reads it. */
  label: string
  path: string
  /** Read for every project, rather than for the project of the current folder. */
  global: boolean
}

/** How the skills are put in a folder: copied, or linked to the installation of the devtool. */
export type SkillInstallMode = 'copy' | 'link'

/** What a sync changed in a folder, by skill name. */
export interface SkillSyncResult {
  folder: string
  added: string[]
  updated: string[]
  removed: string[]
  unchanged: string[]
  /** Skills of the same name the user made, left untouched. */
  skipped: string[]
}

const MANIFEST = '.devtool-skills.json'

/**
 * Lists the folders the known agents load their skills from, for every project and for the current one.
 * @param cwd The folder of the current project.
 * @returns The folders.
 */
export function agentSkillFolders (cwd = process.cwd()): AgentSkillFolder[] {
  return [
    { label: 'Codex CLI, Gemini CLI, Cursor, Amp and the other agents of the format', path: path.join(os.homedir(), '.agents', 'skills'), global: true },
    { label: 'Claude Code', path: path.join(os.homedir(), '.claude', 'skills'), global: true },
    { label: 'Codex CLI, Gemini CLI, Cursor, Amp... in this project', path: path.join(cwd, '.agents', 'skills'), global: false },
    { label: 'Claude Code in this project', path: path.join(cwd, '.claude', 'skills'), global: false }
  ]
}

/**
 * Lists the skills of a folder: its sub-folders holding a `SKILL.md`.
 * @param folder The folder.
 * @returns The names of the skills, sorted.
 */
export async function listSkills (folder: string): Promise<string[]> {
  const entries = await fs.readdir(folder, { withFileTypes: true })
  const skills = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => (await exists(path.join(folder, entry.name, 'SKILL.md'))) ? entry.name : null))
  return skills.filter(skill => skill !== null).sort()
}

/**
 * Gives the folders that are distinct once their links are followed, keeping the first of each.
 * @param folders The folders, which may not exist yet.
 * @returns The distinct folders, in their order.
 */
export async function distinctFolders (folders: string[]): Promise<string[]> {
  const seen = new Set<string>()
  const distinct: string[] = []
  for (const folder of folders) {
    const real = await realPath(folder)
    if (!seen.has(real)) {
      seen.add(real)
      distinct.push(folder)
    }
  }
  return distinct
}

/**
 * Tells whether a sync already installed skills in a folder.
 * @param folder The folder.
 * @returns True when the folder holds the manifest of a sync.
 */
export async function wasSynced (folder: string): Promise<boolean> {
  return exists(path.join(folder, MANIFEST))
}

/**
 * Lists the skills of the source a folder already holds without a sync having installed them.
 * @param source The folder of the skills of the devtool.
 * @param folder The folder of the agent.
 * @returns The names of the skills the user made under the same name.
 */
export async function foreignSkills (source: string, folder: string): Promise<string[]> {
  const managed = await readManifest(folder)
  const skills = await listSkills(source)
  const present = await Promise.all(skills.map(async skill => !managed.includes(skill) && (await exists(path.join(folder, skill)))))
  return skills.filter((_, index) => present[index])
}

/**
 * Installs the skills of the devtool in a folder, replacing those a previous sync installed, removing
 * those the devtool no longer has, and leaving the skills of the user alone unless told to replace them.
 * @param options The sync.
 * @param options.source The folder of the skills of the devtool.
 * @param options.folder The folder of the agent.
 * @param options.mode Whether to copy or link the skills.
 * @param options.replace Skills the user made under the same name that may be replaced.
 * @returns What changed.
 */
export async function syncSkills ({ source, folder, mode, replace = [] }: { source: string, folder: string, mode: SkillInstallMode, replace?: string[] }): Promise<SkillSyncResult> {
  const result: SkillSyncResult = { folder, added: [], updated: [], removed: [], unchanged: [], skipped: [] }
  const managed = await readManifest(folder)
  const skills = await listSkills(source)
  await fs.mkdir(folder, { recursive: true })

  const installed: string[] = []
  for (const skill of skills) {
    const from = path.join(source, skill)
    const to = path.join(folder, skill)
    const present = await exists(to)
    if (present && !managed.includes(skill) && !replace.includes(skill)) {
      result.skipped.push(skill)
      continue
    }

    installed.push(skill)
    if (present && (await isInstalled(from, to, mode))) {
      result.unchanged.push(skill)
      continue
    }
    await fs.rm(to, { recursive: true, force: true })
    if (mode === 'link') {
      await fs.symlink(path.resolve(from), to, 'dir')
    } else {
      await fs.cp(from, to, { recursive: true })
    }
    result[present ? 'updated' : 'added'].push(skill)
  }

  for (const skill of managed.filter(name => !skills.includes(name))) {
    await fs.rm(path.join(folder, skill), { recursive: true, force: true })
    result.removed.push(skill)
  }
  await fs.writeFile(path.join(folder, MANIFEST), `${JSON.stringify({ skills: installed }, null, 2)}\n`)
  return result
}

/**
 * Tells whether a skill is already in place in the given mode, with the content of the source.
 * @param from The skill of the devtool.
 * @param to The skill in the folder of the agent.
 * @param mode How it should be put.
 * @returns True when nothing has to change.
 */
async function isInstalled (from: string, to: string, mode: SkillInstallMode): Promise<boolean> {
  const link = (await fs.lstat(to)).isSymbolicLink()
  if (mode === 'link') {
    return link && path.resolve(path.dirname(to), await fs.readlink(to)) === path.resolve(from)
  }
  return !link && (await sameTree(from, to))
}

/**
 * Tells whether two folders hold the same files with the same contents.
 * @param a The first folder.
 * @param b The second folder.
 * @returns True when they match.
 */
async function sameTree (a: string, b: string): Promise<boolean> {
  const [filesA, filesB] = await Promise.all([a, b].map(async folder => (await fs.readdir(folder, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => path.relative(folder, path.join(entry.parentPath, entry.name))).sort()))
  if (filesA.join('\n') !== filesB.join('\n')) {
    return false
  }
  for (const file of filesA) {
    const [contentA, contentB] = await Promise.all([fs.readFile(path.join(a, file)), fs.readFile(path.join(b, file))])
    if (!contentA.equals(contentB)) {
      return false
    }
  }
  return true
}

/**
 * Reads the skills a previous sync installed in a folder.
 * @param folder The folder.
 * @returns Their names, none when no sync ran there.
 */
async function readManifest (folder: string): Promise<string[]> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(folder, MANIFEST), 'utf8')) as { skills?: unknown }
    return Array.isArray(manifest.skills) ? manifest.skills.filter((skill): skill is string => typeof skill === 'string') : []
  } catch {
    return []
  }
}

/**
 * Gives the real path of a folder, following its links, or of its closest existing parent.
 * @param folder The folder, which may not exist.
 * @returns The real path.
 */
async function realPath (folder: string): Promise<string> {
  try {
    return await fs.realpath(folder)
  } catch {
    const parent = path.dirname(folder)
    return parent === folder ? folder : path.join(await realPath(parent), path.basename(folder))
  }
}

/**
 * Tells whether a path exists, a dangling link included.
 * @param target The path.
 * @returns True when something is there.
 */
async function exists (target: string): Promise<boolean> {
  return fs.lstat(target).then(() => true, () => false)
}
