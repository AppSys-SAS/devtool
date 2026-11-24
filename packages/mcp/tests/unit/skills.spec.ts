import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SkillsExtension } from '@modelcontextprotocol/server/ext/skills'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { joinedSkillFiles, type SkillFolder } from '../../src/skills.js'

let root: string

/**
 * Writes an agent skill.
 * @param folder The folder holding the skills.
 * @param name The name of the skill.
 * @param extra Other files of the skill, by path.
 */
async function writeSkill (folder: string, name: string, extra: Record<string, string> = {}): Promise<void> {
  await fs.mkdir(path.join(folder, name), { recursive: true })
  await fs.writeFile(path.join(folder, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Does ${name}.\n---\n\n# ${name}\n`)
  for (const [file, content] of Object.entries(extra)) {
    await fs.mkdir(path.dirname(path.join(folder, name, file)), { recursive: true })
    await fs.writeFile(path.join(folder, name, file), content)
  }
}

/**
 * Lists the skills a catalog serves from folders.
 * @param folders The folders.
 * @returns The URIs of their `SKILL.md`.
 */
async function servedUris (folders: SkillFolder[]): Promise<string[]> {
  const catalog = await SkillsExtension.load(joinedSkillFiles(() => folders))
  return catalog.entries.map(skill => skill.uri)
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-skills-'))
  await writeSkill(path.join(root, 'devtool'), 'devtool-terminals')
  await writeSkill(path.join(root, 'team'), 'review', { 'references/checklist.md': '- tests\n' })
  await writeSkill(path.join(root, 'team'), 'deploy-web')
  await writeSkill(path.join(root, 'team'), 'private-notes')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('joinedSkillFiles', () => {
  it('serves the skills of every folder under its prefix, only those its globs match', async () => {
    expect(await servedUris([
      { prefix: 'devtool', folder: path.join(root, 'devtool'), include: ['*'] },
      { prefix: 'files/team/team/skills', folder: path.join(root, 'team'), include: ['review', 'deploy-*'] }
    ])).toEqual([
      'skill://devtool/devtool-terminals/SKILL.md',
      'skill://files/team/team/skills/deploy-web/SKILL.md',
      'skill://files/team/team/skills/review/SKILL.md'
    ])
  })

  it('reads the files of a served skill and refuses the others', async () => {
    const files = joinedSkillFiles(() => [{ prefix: 'team', folder: path.join(root, 'team'), include: ['review'] }])

    expect(Buffer.from(await files.read('team/review/references/checklist.md')).toString()).toBe('- tests\n')
    await expect(files.read('team/private-notes/SKILL.md')).rejects.toThrow('team/private-notes/SKILL.md is not a file of a served skill')
    await expect(files.read('team/review/../private-notes/SKILL.md')).rejects.toThrow('is not a file of a served skill')
    await expect(files.read('other/review/SKILL.md')).rejects.toThrow('is not a file of a served skill')
  })

  it('serves nothing from a missing folder', async () => {
    expect(await servedUris([{ prefix: 'gone', folder: path.join(root, 'gone'), include: ['*'] }])).toEqual([])
  })

  it('follows the folders it is given at each reload', async () => {
    let folders: SkillFolder[] = []
    const catalog = await SkillsExtension.load(joinedSkillFiles(() => folders))
    folders = [{ prefix: 'devtool', folder: path.join(root, 'devtool'), include: ['*'] }]

    expect(await catalog.reload()).toMatchObject({ added: ['skill://devtool/devtool-terminals/SKILL.md'], listChanged: true })
  })
})
