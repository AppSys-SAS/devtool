import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { type BackendContext, type BackendSettings, type BackendType, type EnvironmentBackend, readText, type RemoteFile } from './backend.js'

const execFileAsync = promisify(execFile)
const COMMIT_MARKER = '@@devtool-commit@@'
const DEFAULT_IDENTITY = ['-c', 'user.name=devtool', '-c', 'user.email=devtool@localhost']

/** Settings of a git repository storing the files, each push a commit. */
export interface GitSettings extends BackendSettings {
  type: 'git'
  /** Address of the repository, as `git clone` takes it. */
  url: string
  branch: string
  /** Folder of the files in the repository, empty for its root, else ending with `/`. */
  path: string
}

/**
 * Files of the environment in a git repository, through a working copy kept in the cache folder.
 */
class GitBackend implements EnvironmentBackend {
  private _queue: Promise<unknown> = Promise.resolve()
  private _identity: Promise<string[]> | null = null

  /**
   * @param _settings The repository, its branch and the folder of the files.
   * @param _folder The working copy of the repository.
   */
  constructor (private readonly _settings: GitSettings, private readonly _folder: string) {}

  /**
   * Lists the tracked files of the folder, each dated and versioned by the last commit changing it.
   * @returns The files.
   */
  async list (): Promise<RemoteFile[]> {
    return this.serialize(async () => {
      if (!(await this.sync())) {
        return []
      }
      const prefix = this._settings.path
      const tracked = (await this.git(['ls-files', '-z', '--', prefix === '' ? '.' : prefix])).split('\0').filter(file => file !== '')
      const commits = new Map<string, { sha: string, date: Date }>()
      let current: { sha: string, date: Date } | null = null
      for (const line of (await this.git(['-c', 'core.quotePath=false', 'log', `--format=${COMMIT_MARKER}%H %cI`, '--name-only', '--', prefix === '' ? '.' : prefix])).split('\n')) {
        if (line.startsWith(COMMIT_MARKER)) {
          const [sha, date] = line.slice(COMMIT_MARKER.length).split(' ')
          current = { sha, date: new Date(date) }
        } else if (line !== '' && current !== null && !commits.has(line)) {
          commits.set(line, current)
        }
      }
      return Promise.all(tracked.map(async file => {
        const commit = commits.get(file)
        const { size } = await fs.stat(path.join(this._folder, file))
        return { path: file.slice(prefix.length), size, updatedAt: commit?.date ?? new Date(0), version: commit?.sha ?? '' }
      }))
    })
  }

  /**
   * Opens a stored file, copied out of the working copy so later operations do not change it while it is read.
   * @param filePath The path of the file.
   * @returns Its content, or null when the repository does not hold it.
   */
  async download (filePath: string): Promise<Readable | null> {
    const copy = await this.serialize(async () => {
      if (!(await this.sync())) {
        return null
      }
      const source = this.pathOf(filePath)
      if (!(await fs.stat(source).then(stat => stat.isFile(), () => false))) {
        return null
      }
      const temporary = path.join(os.tmpdir(), `devtool-git-${randomUUID()}`)
      await fs.copyFile(source, temporary)
      return temporary
    })
    if (copy === null) {
      return null
    }
    const content = createReadStream(copy)
    content.on('close', () => {
      void fs.rm(copy, { force: true })
    })
    return content
  }

  /**
   * Commits a local file into the repository and pushes it, nothing being committed when it did not change.
   * @param filePath The path of the file in the repository folder.
   * @param localFile The local file.
   */
  async upload (filePath: string, localFile: string): Promise<void> {
    await this.serialize(async () => {
      await this.sync()
      const target = this.pathOf(filePath)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.copyFile(localFile, target)
      await this.git(['add', '--', this._settings.path + filePath])
      await this.commitAndPush(`devtool: push ${filePath}`)
    })
  }

  /**
   * Removes a file from the repository and pushes the removal; a missing file counts as removed.
   * @param filePath The path of the file.
   */
  async remove (filePath: string): Promise<void> {
    await this.serialize(async () => {
      if (!(await this.sync()) || !(await fs.stat(this.pathOf(filePath)).then(() => true, () => false))) {
        return
      }
      await this.git(['rm', '-q', '--', this._settings.path + filePath])
      await this.commitAndPush(`devtool: remove ${filePath}`)
    })
  }

  /**
   * Keeps no connection open.
   */
  async close (): Promise<void> {
    await Promise.resolve()
  }

  /**
   * Brings the working copy to the branch of the remote, creating the working copy on first use.
   * @returns False when the remote has no such branch yet.
   */
  private async sync (): Promise<boolean> {
    if (!(await fs.stat(path.join(this._folder, '.git')).then(() => true, () => false))) {
      await fs.mkdir(this._folder, { recursive: true })
      await this.git(['init', '-q'])
      await this.git(['remote', 'add', 'origin', this._settings.url])
    } else {
      await this.git(['remote', 'set-url', 'origin', this._settings.url])
    }
    const { branch } = this._settings
    if ((await this.git(['ls-remote', '--heads', 'origin', branch])).trim() === '') {
      if (!(await this.hasCommits())) {
        await this.git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
      }
      return false
    }
    await this.git(['fetch', '-q', 'origin', branch])
    await this.git(['checkout', '-q', '-B', branch, `origin/${branch}`])
    await this.git(['reset', '-q', '--hard', `origin/${branch}`])
    await this.git(['clean', '-q', '-fd'])
    return true
  }

  /**
   * Commits what is staged and pushes it, rebasing once on the remote when the push is refused.
   * @param message The message of the commit.
   */
  private async commitAndPush (message: string): Promise<void> {
    const staged = await execFileAsync('git', ['-C', this._folder, 'diff', '--cached', '--quiet']).then(() => false, () => true)
    if (!staged) {
      return
    }
    await this.git([...(await this.identity()), 'commit', '-q', '-m', message])
    const push = ['push', '-q', 'origin', `HEAD:${this._settings.branch}`]
    try {
      await this.git(push)
    } catch {
      await this.git(['fetch', '-q', 'origin', this._settings.branch])
      await this.git([...(await this.identity()), 'rebase', '-q', `origin/${this._settings.branch}`])
      await this.git(push)
    }
  }

  /**
   * Gives the identity options of the commits: none when git knows the user, else a devtool identity.
   * @returns The options to give git.
   */
  private async identity (): Promise<string[]> {
    this._identity ??= execFileAsync('git', ['-C', this._folder, 'config', 'user.email']).then(() => [], () => DEFAULT_IDENTITY)
    return this._identity
  }

  /**
   * Tells whether the working copy holds commits.
   * @returns True once a commit exists.
   */
  private async hasCommits (): Promise<boolean> {
    return execFileAsync('git', ['-C', this._folder, 'rev-parse', '--verify', '-q', 'HEAD']).then(() => true, () => false)
  }

  /**
   * Gives the path of a file in the working copy, refusing paths leaving the folder of the files.
   * @param filePath The path of the file.
   * @returns The absolute path.
   */
  private pathOf (filePath: string): string {
    const relative = path.posix.normalize(filePath)
    if (relative.startsWith('../') || relative === '..' || path.posix.isAbsolute(relative)) {
      throw new Error(`${filePath} leaves the folder of the repository`)
    }
    return path.join(this._folder, this._settings.path, relative)
  }

  /**
   * Runs git in the working copy, never asking for credentials.
   * @param args The arguments of git.
   * @returns The standard output.
   */
  private async git (args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', this._folder, ...args], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        maxBuffer: 64 * 1024 * 1024
      })
      return stdout
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim()
      throw new Error(`git ${args.filter(arg => !arg.startsWith('user.')).join(' ')} failed for ${this._settings.slug}: ${stderr || (error as Error).message}`, { cause: error })
    }
  }

  /**
   * Runs the operations of the backend one after the other, as they share the working copy.
   * @param task The operation.
   * @returns What the operation gives.
   */
  private async serialize<T> (task: () => Promise<T>): Promise<T> {
    const run = this._queue.then(task, task)
    this._queue = run.catch(() => undefined)
    return run
  }
}

/** A git repository, read and written with the git of the machine and its credentials. */
export const git: BackendType<GitSettings> = {
  type: 'git',

  readOptions (section, shared, setting) {
    const url = readText(section.url)
    if (url === null) {
      return { options: null, problems: [{ setting: `${setting}.url`, message: 'must be the address of the repository' }] }
    }
    const folder = readText(section.path)?.replace(/^\/+|\/+$/g, '') ?? ''
    return {
      options: { ...shared, type: 'git', url, branch: readText(section.branch) ?? 'main', path: folder === '' ? '' : `${folder}/` },
      problems: []
    }
  },

  create (options, context: BackendContext) {
    return new GitBackend(options, path.join(context.cacheDir, 'environment', 'git', options.slug))
  }
}
