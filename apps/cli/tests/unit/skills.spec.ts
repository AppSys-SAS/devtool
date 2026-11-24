import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { distinctFolders, foreignSkills, listSkills, syncSkills, wasSynced } from '../../src/skills.js'

let root: string
let source: string
let folder: string

/**
 * Writes a skill of the devtool in the source folder.
 * @param name - The name of the skill.
 * @param body - The instructions of the skill.
 */
async function writeSkill (name: string, body = 'Instructions.'): Promise<void> {
  await fs.mkdir(path.join(source, name), { recursive: true })
  await fs.writeFile(path.join(source, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`)
}

/**
 * Reads the instructions of a skill installed in the folder of the agent.
 * @param name - The name of the skill.
 * @returns The content of its SKILL.md.
 */
async function installed (name: string): Promise<string> {
  return fs.readFile(path.join(folder, name, 'SKILL.md'), 'utf8')
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-skills-')))
  source = path.join(root, 'source')
  folder = path.join(root, 'agent', 'skills')
  await writeSkill('devtool-terminals')
  await writeSkill('devtool-files')
  await fs.writeFile(path.join(source, 'README.md'), 'Not a skill.')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('listSkills', () => {
  it('lists the folders holding a SKILL.md', async () => {
    await fs.mkdir(path.join(source, 'empty'))
    expect(await listSkills(source)).toEqual(['devtool-files', 'devtool-terminals'])
  })
})

describe('syncSkills', () => {
  it('copies the skills into a new folder, then finds nothing to do', async () => {
    expect(await syncSkills({ source, folder, mode: 'copy' })).toMatchObject({ added: ['devtool-files', 'devtool-terminals'], updated: [], removed: [], unchanged: [] })
    expect(await installed('devtool-files')).toContain('Instructions.')
    expect((await fs.lstat(path.join(folder, 'devtool-files'))).isSymbolicLink()).toBe(false)
    expect(await wasSynced(folder)).toBe(true)
    expect(await syncSkills({ source, folder, mode: 'copy' })).toMatchObject({ added: [], updated: [], unchanged: ['devtool-files', 'devtool-terminals'] })
  })

  it('updates a changed skill and removes a skill the devtool no longer has', async () => {
    await syncSkills({ source, folder, mode: 'copy' })
    await writeSkill('devtool-files', 'New instructions.')
    await fs.rm(path.join(source, 'devtool-terminals'), { recursive: true })
    expect(await syncSkills({ source, folder, mode: 'copy' })).toMatchObject({ updated: ['devtool-files'], removed: ['devtool-terminals'] })
    expect(await installed('devtool-files')).toContain('New instructions.')
    await expect(fs.stat(path.join(folder, 'devtool-terminals'))).rejects.toThrow()
  })

  it('links the skills, then switches back to copies', async () => {
    expect(await syncSkills({ source, folder, mode: 'link' })).toMatchObject({ added: ['devtool-files', 'devtool-terminals'] })
    expect(await fs.readlink(path.join(folder, 'devtool-files'))).toBe(path.join(source, 'devtool-files'))
    expect(await syncSkills({ source, folder, mode: 'link' })).toMatchObject({ unchanged: ['devtool-files', 'devtool-terminals'] })
    expect(await syncSkills({ source, folder, mode: 'copy' })).toMatchObject({ updated: ['devtool-files', 'devtool-terminals'] })
    expect((await fs.lstat(path.join(folder, 'devtool-files'))).isSymbolicLink()).toBe(false)
    expect(await fs.readdir(path.join(source, 'devtool-files'))).toEqual(['SKILL.md'])
  })

  it('keeps the skills the user made, unless told to replace them, and never removes them', async () => {
    await fs.mkdir(path.join(folder, 'devtool-files'), { recursive: true })
    await fs.writeFile(path.join(folder, 'devtool-files', 'SKILL.md'), 'Mine.')
    await fs.mkdir(path.join(folder, 'my-skill'))
    expect(await foreignSkills(source, folder)).toEqual(['devtool-files'])

    expect(await syncSkills({ source, folder, mode: 'copy' })).toMatchObject({ added: ['devtool-terminals'], skipped: ['devtool-files'] })
    expect(await installed('devtool-files')).toBe('Mine.')
    expect(await syncSkills({ source, folder, mode: 'copy', replace: ['devtool-files'] })).toMatchObject({ updated: ['devtool-files'], skipped: [] })
    expect(await foreignSkills(source, folder)).toEqual([])
    expect(await fs.readdir(folder)).toContain('my-skill')
  })
})

describe('distinctFolders', () => {
  it('keeps one of the folders a link joins, even before they exist', async () => {
    const claude = path.join(root, 'claude-skills')
    await fs.mkdir(folder, { recursive: true })
    await fs.symlink(folder, claude)
    expect(await distinctFolders([folder, claude, path.join(root, 'new', 'skills')])).toEqual([folder, path.join(root, 'new', 'skills')])
  })
})
