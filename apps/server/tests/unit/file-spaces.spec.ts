import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TreeFileSpace } from '../../src/file-spaces.js'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-file-space-'))
  await fs.mkdir(path.join(root, '.git'))
  await fs.mkdir(path.join(root, '.github'))
  await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  await fs.writeFile(path.join(root, '.github', 'ci.yml'), 'on: push\n')
  await fs.writeFile(path.join(root, '.env'), 'PORT=8080\n')
  await fs.writeFile(path.join(root, 'app.yml'), 'port: 8080\n')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/**
 * Lists the paths of a file space.
 * @param space - The space.
 * @returns The paths of its entries.
 */
async function pathsOf (space: TreeFileSpace): Promise<string[]> {
  return (await space.tree()).entries.map(entry => entry.path)
}

describe('TreeFileSpace', () => {
  it('hides the files and folders whose name starts with a dot by default', async () => {
    const space = new TreeFileSpace('test', root)

    expect(await pathsOf(space)).toEqual(['app.yml'])
    expect((await space.read('.env')).error).toMatch(/is not a path of test/)
  })

  it('shows them when asked, .git aside', async () => {
    const space = new TreeFileSpace('test', root, true)

    expect(await pathsOf(space)).toEqual(['.env', '.github', '.github/ci.yml', 'app.yml'])
    expect((await space.read('.env')).content).toBe('PORT=8080\n')
    expect((await space.read('.git/HEAD')).error).toMatch(/is not a path of test/)
    expect((await space.read('../outside')).error).toMatch(/is not a path of test/)
  })
})
