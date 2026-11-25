import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendContext, EnvironmentBackend } from '../../src/backends/backend.js'
import { git } from '../../src/backends/git.js'

const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'])
    return true
  } catch {
    return false
  }
})()

let folder: string
let remote: string
let globalConfig: string | undefined

/**
 * Creates a git backend on the test remote, with a working copy of its own.
 * @param name - The name of the backend, naming its working copy.
 * @param settings - Raw settings merged over the url of the remote.
 * @returns The backend.
 */
function backendOf (name: string, settings: Record<string, unknown> = {}): EnvironmentBackend {
  const { options, problems } = git.readOptions({ url: remote, ...settings }, { type: 'git', slug: name, default: true, encryption: null, groups: { pull: null, push: null } }, `environment.backends.${name}`)
  if (!options) {
    throw new Error(JSON.stringify(problems))
  }
  const context: BackendContext = { resolve: async text => text, askSecret: async () => '', cacheDir: path.join(folder, `cache-${name}`), configFolder: folder, auth: null }
  return git.create(options, context)
}

/**
 * Reads a whole stream as text.
 * @param stream - The stream.
 * @returns The text.
 */
async function textOf (stream: Readable | null): Promise<string | null> {
  if (stream === null) {
    return null
  }
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Writes a local file to upload.
 * @param name - The name of the file.
 * @param content - Its content.
 * @returns Its path.
 */
async function localFile (name: string, content: string): Promise<string> {
  const file = path.join(folder, name)
  await fs.writeFile(file, content)
  return file
}

/**
 * Lists the commit subjects of the remote, the newest first.
 * @returns The subjects.
 */
function remoteLog (): string[] {
  return execFileSync('git', ['--git-dir', remote, 'log', '--format=%s', 'main'], { encoding: 'utf8' }).trim().split('\n')
}

beforeEach(async () => {
  folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-git-')))
  remote = path.join(folder, 'remote.git')
  globalConfig = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = path.join(folder, 'gitconfig')
  await fs.writeFile(process.env.GIT_CONFIG_GLOBAL, '')
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', remote])
})

afterEach(async () => {
  if (globalConfig === undefined) {
    delete process.env.GIT_CONFIG_GLOBAL
  } else {
    process.env.GIT_CONFIG_GLOBAL = globalConfig
  }
  await fs.rm(folder, { recursive: true, force: true })
})

describe.skipIf(!hasGit)('git backend', () => {
  it('lists nothing in an empty repository, then pushes the first file into it', async () => {
    const backend = backendOf('team')
    expect(await backend.list()).toEqual([])
    expect(await backend.download('api/config.yml')).toBeNull()

    await backend.upload('api/config.yml', await localFile('a', 'port: 3000\n'), 'application/yaml')
    const [file] = (await backend.list())!
    expect(file).toMatchObject({ path: 'api/config.yml', size: 11 })
    expect(file.version).toMatch(/^[0-9a-f]{40}$/)
    expect(file.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(await textOf(await backend.download('api/config.yml'))).toBe('port: 3000\n')
    expect(remoteLog()).toEqual(['devtool: push api/config.yml'])
  })

  it('changes the version of an updated file only, and commits nothing for an unchanged one', async () => {
    const backend = backendOf('team')
    await backend.upload('api/config.yml', await localFile('a', 'one'), 'application/yaml')
    await backend.upload('web/config.yml', await localFile('b', 'web'), 'application/yaml')
    const before = new Map((await backend.list())!.map(file => [file.path, file.version]))

    await backend.upload('api/config.yml', await localFile('c', 'two'), 'application/yaml')
    await backend.upload('web/config.yml', await localFile('d', 'web'), 'application/yaml')
    const after = new Map((await backend.list())!.map(file => [file.path, file.version]))
    expect(after.get('api/config.yml')).not.toBe(before.get('api/config.yml'))
    expect(after.get('web/config.yml')).toBe(before.get('web/config.yml'))
    expect(remoteLog()).toHaveLength(3)
  })

  it('removes a file, a missing one counting as removed', async () => {
    const backend = backendOf('team')
    await backend.upload('team files/db dump.gz', await localFile('a', 'dump'), 'application/gzip')
    await backend.upload('keep.yml', await localFile('b', 'keep'), 'application/yaml')
    await backend.remove('team files/db dump.gz')
    await backend.remove('team files/db dump.gz')
    expect((await backend.list())!.map(file => file.path)).toEqual(['keep.yml'])
    expect(await backend.download('team files/db dump.gz')).toBeNull()
    expect(remoteLog()[0]).toBe('devtool: remove team files/db dump.gz')
  })

  it('keeps the files under its folder of the repository', async () => {
    const backend = backendOf('team', { path: '/environment/' })
    await backend.upload('api/config.yml', await localFile('a', 'x'), 'application/yaml')
    expect((await backend.list())!.map(file => file.path)).toEqual(['api/config.yml'])
    expect(execFileSync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' }).trim()).toBe('environment/api/config.yml')
    expect(await backendOf('other').list().then(files => files!.map(file => file.path))).toEqual(['environment/api/config.yml'])
  })

  it('sees what another working copy pushed, and pushes over it', async () => {
    const first = backendOf('first')
    const second = backendOf('second')
    await first.upload('api/config.yml', await localFile('a', 'from first'), 'application/yaml')
    expect(await textOf(await second.download('api/config.yml'))).toBe('from first')

    await second.upload('web/config.yml', await localFile('b', 'from second'), 'application/yaml')
    await first.upload('api/config.yml', await localFile('c', 'first again'), 'application/yaml')
    expect((await second.list())!.map(file => file.path).sort()).toEqual(['api/config.yml', 'web/config.yml'])
    expect(await textOf(await second.download('api/config.yml'))).toBe('first again')
  })

  it('refuses a path leaving its folder', async () => {
    await expect(backendOf('team').upload('../outside.yml', await localFile('a', 'x'), 'application/yaml')).rejects.toThrow('leaves the folder of the repository')
  })
})
