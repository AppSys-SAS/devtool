import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendContext, EnvironmentBackend } from '../../src/backends/backend.js'
import { git } from '../../src/backends/git.js'
import { expectCompleteProgress, progressContent, progressRecorder } from './progress-fixtures.js'

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
 * Names the working copy of a backend.
 * @param name - The name of the backend.
 * @returns The name of its folder in the cache.
 */
function workingCopyOf (name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 16)
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

describe.skipIf(!hasGit)('git backend', { timeout: 30_000 }, () => {
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

  it('commits and pushes nothing for an upload cancelled before it starts', async () => {
    const backend = backendOf('team')
    await backend.upload('api/config.yml', await localFile('a', 'port: 3000\n'), 'application/yaml')
    const cancel = new AbortController()
    cancel.abort(new Error('cancelled'))

    await expect(backend.upload('api/config.yml', await localFile('b', 'port: 4000\n'), 'application/yaml', { signal: cancel.signal })).rejects.toThrow('cancelled')
    expect(remoteLog()).toEqual(['devtool: push api/config.yml'])
    expect(await textOf(await backend.download('api/config.yml'))).toBe('port: 3000\n')
  })

  it('cancels an upload waiting behind a listing whose remote does not answer, then stops that listing', async () => {
    const backend = backendOf('team')
    await backend.upload('api/config.yml', await localFile('a', 'port: 3000\n'), 'application/yaml')
    await fs.writeFile(process.env.GIT_CONFIG_GLOBAL!, '[remote "origin"]\n\tuploadpack = sh -c \'sleep 30\'\n')
    const listing = new AbortController()
    const listed = backend.list(listing.signal)
    const cancel = new AbortController()
    setTimeout(() => cancel.abort(new Error('cancelled')), 200)

    await expect(backend.upload('api/config.yml', await localFile('b', 'port: 4000\n'), 'application/yaml', { signal: cancel.signal })).rejects.toThrow('cancelled')
    listing.abort(new Error('abandoned'))
    await expect(listed).rejects.toThrow()
    await fs.writeFile(process.env.GIT_CONFIG_GLOBAL!, '')
    expect(remoteLog()).toEqual(['devtool: push api/config.yml'])
    expect(await textOf(await backend.download('api/config.yml'))).toBe('port: 3000\n')
  }, 10_000)

  it('bounds its exchanges itself, keeps a working copy per name, any name, and waits for another process using it', async () => {
    const backend = backendOf('équipe env')
    expect(backend.boundsItself).toBe(true)
    await backend.upload('api/config.yml', await localFile('a', 'port: 3000\n'), 'application/yaml')
    await backendOf('Équipe env').list()
    expect(workingCopyOf('équipe env')).not.toBe(workingCopyOf('Équipe env'))
    for (const name of ['équipe env', 'Équipe env']) {
      expect((await fs.stat(path.join(folder, `cache-${name}`, 'environment', 'git', workingCopyOf(name), '.git'))).isDirectory()).toBe(true)
    }

    const lock = path.join(folder, 'cache-équipe env', 'environment', 'git', `${workingCopyOf('équipe env')}.lock`)
    await fs.writeFile(lock, String(process.ppid))
    let listed = false
    const listing = backend.list().then(files => {
      listed = true
      return files
    })
    await delay(300)
    expect(listed).toBe(false)
    await fs.rm(lock)
    expect((await listing)?.map(file => file.path)).toEqual(['api/config.yml'])
  })

  it('cancels a commit waiting for the developer', async () => {
    const hooks = path.join(folder, 'hooks')
    await fs.mkdir(hooks)
    await fs.writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 })
    await fs.writeFile(process.env.GIT_CONFIG_GLOBAL!, `[core]\n\thooksPath = ${hooks}\n`)
    const cancel = new AbortController()
    setTimeout(() => cancel.abort(new Error('cancelled')), 500)
    const started = Date.now()

    await expect(backendOf('team').upload('api/config.yml', await localFile('a', 'port: 3000\n'), 'application/yaml', { signal: cancel.signal })).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(5000)
    await fs.writeFile(process.env.GIT_CONFIG_GLOBAL!, '')
  }, 15_000)

  it('never publishes a file of a first commit that was cancelled with the next upload', async () => {
    const hooks = path.join(folder, 'hooks')
    await fs.mkdir(hooks)
    await fs.writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\nsleep 3\n', { mode: 0o755 })
    await fs.writeFile(process.env.GIT_CONFIG_GLOBAL!, `[core]\n\thooksPath = ${hooks}\n`)
    const backend = backendOf('team')
    const cancel = new AbortController()
    setTimeout(() => cancel.abort(new Error('cancelled')), 1000)
    await expect(backend.upload('api/cancelled.yml', await localFile('a', 'cancelled: true\n'), 'application/yaml', { signal: cancel.signal })).rejects.toThrow()

    await fs.writeFile(process.env.GIT_CONFIG_GLOBAL!, '')
    await backend.upload('api/config.yml', await localFile('b', 'port: 3000\n'), 'application/yaml')
    expect(execFileSync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' }).trim()).toBe('api/config.yml')
  }, 15_000)

  it('never publishes a first push that failed with the next upload', async () => {
    const hook = path.join(remote, 'hooks', 'pre-receive')
    await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const backend = backendOf('team')
    await expect(backend.upload('api/refused.yml', await localFile('a', 'refused: true\n'), 'application/yaml')).rejects.toThrow()

    await fs.rm(hook)
    await backend.upload('api/config.yml', await localFile('b', 'port: 3000\n'), 'application/yaml')
    expect(execFileSync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' }).trim()).toBe('api/config.yml')
  })

  it.each(['--merge', '--apply'])('recovers a working copy left in the middle of a conflicting rebase run with %s', async mode => {
    const first = backendOf('first')
    const second = backendOf('second')
    await first.upload('api/config.yml', await localFile('a', 'port: 3000\n'), 'application/yaml')
    expect(await textOf(await second.download('api/config.yml'))).toBe('port: 3000\n')
    await first.upload('api/config.yml', await localFile('b', 'port: 4000\n'), 'application/yaml')
    const copy = path.join(folder, 'cache-second', 'environment', 'git', workingCopyOf('second'))
    const run = (args: string[]): void => {
      execFileSync('git', ['-C', copy, '-c', 'user.name=dev', '-c', 'user.email=dev@localhost', ...args], { stdio: 'ignore' })
    }
    await fs.writeFile(path.join(copy, 'api', 'config.yml'), 'port: 5000\n')
    run(['commit', '-qam', 'local change'])
    run(['fetch', '-q', 'origin', 'main'])
    expect(() => {
      run(['rebase', mode, 'origin/main'])
    }).toThrow()

    expect(await textOf(await second.download('api/config.yml'))).toBe('port: 4000\n')
    await second.upload('api/config.yml', await localFile('c', 'port: 6000\n'), 'application/yaml')
    expect(await textOf(await first.download('api/config.yml'))).toBe('port: 6000\n')
  })

  it('runs one operation at a time on a working copy two backends of the process share', async () => {
    const one = backendOf('team')
    const other = backendOf('team')
    await one.upload('api/config.yml', await localFile('a', 'port: 3000\n'), 'application/yaml')

    await Promise.all(Array.from({ length: 4 }, async (_, index) => Promise.all([
      one.upload(`api/file-${index}.yml`, await localFile(`f${index}`, `value: ${index}\n`), 'application/yaml'),
      other.list()
    ])))
    expect((await other.list())?.map(file => file.path).sort()).toEqual(['api/config.yml', 'api/file-0.yml', 'api/file-1.yml', 'api/file-2.yml', 'api/file-3.yml'])
  }, 20_000)

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

  it('reports the bytes git writes to the remote and the bytes read back, against the size of the file', async () => {
    const backend = backendOf('team')
    const content = progressContent()
    const file = path.join(folder, 'db.gz')
    await fs.writeFile(file, content)

    const sent = progressRecorder()
    await backend.upload('api/db.gz', file, 'application/gzip', { onProgress: sent.onProgress })
    expect(sent.reports.length).toBeGreaterThan(0)
    expect(sent.reports.every(([done, total]) => done > 0 && total === content.length)).toBe(true)

    const received = progressRecorder()
    const chunks: Buffer[] = []
    for await (const chunk of await backendOf('other').download('api/db.gz', { onProgress: received.onProgress }) ?? []) {
      chunks.push(chunk as Buffer)
    }
    expect(Buffer.concat(chunks).equals(content)).toBe(true)
    expectCompleteProgress(received.reports, content.length)
  })
})
