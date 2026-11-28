import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline, type Readable } from 'node:stream'
import { promisify } from 'node:util'
import { scratchPath, withFileLock } from '../directory.js'
import { BACKEND_IDLE_MS, type BackendContext, type BackendSettings, type BackendType, byteCounter, type EnvironmentBackend, lineReader, readText, type RemoteFile, STDIO_GRACE_MS, type TransferOptions } from './backend.js'

const execFileAsync = promisify(execFile)
const queues = new Map<string, Promise<unknown>>()
const COMMIT_MARKER = '@@devtool-commit@@'
const DEFAULT_IDENTITY = ['-c', 'user.name=devtool', '-c', 'user.email=devtool@localhost']
const PROGRESS_LINE = /^(Enumerating|Counting|Delta compression|Compressing|Writing|Total) /
const WRITTEN_PATTERN = /^Writing objects:.*?, (\d+(?:\.\d+)?) (bytes|KiB|MiB|GiB)/
const WRITTEN_ALL = /, done\.?$/
const SENT_ALL = /^Writing objects: +100% /
const UNIT_BYTES: Record<string, number> = { bytes: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }
const IDLE_SECONDS = Math.max(1, Math.round(BACKEND_IDLE_MS / 1000))
const TRANSPORT_LIMITS = ['-c', 'http.lowSpeedLimit=1', '-c', `http.lowSpeedTime=${IDLE_SECONDS}`]
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null']
const REMOTE_COMMANDS = new Set(['ls-remote', 'fetch', 'push'])
const SSH_COMMAND = `ssh -o ConnectTimeout=${IDLE_SECONDS} -o ServerAliveInterval=${Math.max(1, Math.round(IDLE_SECONDS / 4))} -o ServerAliveCountMax=3`
const WORKING_COPY_WAIT_MS = 10 * 60_000

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
 * Its exchanges are bounded by git itself: one that moves no data for a while fails, one that moves
 * slowly runs to its end, and what git or SSH asks the developer is not timed.
 */
class GitBackend implements EnvironmentBackend {
  readonly boundsItself = true
  private _identity: Promise<string[]> | null = null
  private _sshCommand: Promise<Record<string, string>> | null = null

  /**
   * @param _settings The repository, its branch and the folder of the files.
   * @param _folder The working copy of the repository.
   * @param _cacheDir The cache folder of the devtool, holding the copies being read.
   */
  constructor (private readonly _settings: GitSettings, private readonly _folder: string, private readonly _cacheDir: string) {}

  /**
   * Lists the tracked files of the folder, each dated and versioned by the last commit changing it.
   * @param signal Abandons the listing, stopping its exchanges with the remote.
   * @returns The files.
   */
  async list (signal?: AbortSignal): Promise<RemoteFile[]> {
    return this.serialize(async () => {
      if (!(await this.sync(signal))) {
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
    }, signal)
  }

  /**
   * Opens a stored file, copied out of the working copy so later operations do not change it while
   * it is read; a copy that cannot be removed once read is left to the next process.
   * @param filePath The path of the file.
   * @param options Follows the bytes read from the copy, and abandons the download.
   * @returns Its content, or null when the repository does not hold it.
   */
  async download (filePath: string, { onProgress, signal }: TransferOptions = {}): Promise<Readable | null> {
    const copy = await this.serialize(async () => {
      if (!(await this.sync(signal))) {
        return null
      }
      const source = await fs.stat(this.pathOf(filePath)).catch(() => null)
      if (!source?.isFile()) {
        return null
      }
      const temporary = await scratchPath(this._cacheDir, 'git')
      await fs.copyFile(this.pathOf(filePath), temporary)
      return { temporary, size: source.size }
    }, signal)
    if (copy === null) {
      return null
    }
    const content = createReadStream(copy.temporary)
    content.on('close', () => {
      fs.rm(copy.temporary, { force: true }).catch(() => undefined)
    })
    return pipeline(content, byteCounter(copy.size, onProgress), () => undefined)
  }

  /**
   * Commits a local file into the repository and pushes it, nothing being committed when it did not change.
   * @param filePath The path of the file in the repository folder.
   * @param localFile The local file.
   * @param _mediaType Unused, a file of the repository having no media type.
   * @param options Follows the bytes git writes to the remote, the size of the file standing for the
   * total, which is told once git wrote every object, and cancels the push.
   */
  async upload (filePath: string, localFile: string, _mediaType: string, { onProgress, signal }: TransferOptions = {}): Promise<void> {
    await this.serialize(async () => {
      await this.sync(signal)
      const target = this.pathOf(filePath)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.copyFile(localFile, target)
      const { size } = await fs.stat(target)
      await this.git(['add', '--', this._settings.path + filePath], undefined, signal)
      await this.commitAndPush(`devtool: push ${filePath}`, (bytes, all) => onProgress?.(all ? Math.max(bytes, size) : bytes, size), signal)
    }, signal)
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
   * Brings the working copy to the branch of the remote, creating the working copy on first use, and
   * again, empty, while the remote has no such branch yet, so that nothing an earlier operation left
   * is pushed with the next file. A rebase an earlier process left unfinished is undone first.
   * @param signal Stops the exchanges with the remote, which leave the working copy as it was.
   * @returns False when the remote has no such branch yet.
   */
  private async sync (signal?: AbortSignal): Promise<boolean> {
    if (!(await fs.stat(path.join(this._folder, '.git')).then(() => true, () => false))) {
      await this.create()
    } else {
      await this.git(['remote', 'set-url', 'origin', this._settings.url])
      if (await this.rebasing()) {
        await this.git(['rebase', '--abort'])
      }
    }
    const { branch } = this._settings
    if ((await this.git(['ls-remote', '--heads', 'origin', branch], undefined, signal)).trim() === '') {
      await fs.rm(this._folder, { recursive: true, force: true })
      await this.create()
      await this.git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
      return false
    }
    await this.git(['fetch', '-q', 'origin', branch], undefined, signal)
    signal?.throwIfAborted()
    await this.git(['checkout', '-q', '-B', branch, `origin/${branch}`])
    await this.git(['reset', '-q', '--hard', `origin/${branch}`])
    await this.git(['clean', '-q', '-fd'])
    return true
  }

  /**
   * Creates the working copy, empty, its remote set.
   */
  private async create (): Promise<void> {
    await fs.mkdir(this._folder, { recursive: true })
    await this.git(['init', '-q'])
    await this.git(['remote', 'add', 'origin', this._settings.url])
  }

  /**
   * Tells whether a rebase is under way in the working copy, whichever way git runs it.
   * @returns True while a rebase is unfinished.
   */
  private async rebasing (): Promise<boolean> {
    for (const state of ['rebase-merge', 'rebase-apply']) {
      const statePath = (await this.git(['rev-parse', '--git-path', state])).trim()
      if (await fs.stat(path.resolve(this._folder, statePath)).then(() => true, () => false)) {
        return true
      }
    }
    return false
  }

  /**
   * Commits what is staged and pushes it, rebasing once on the remote when the push is refused, a
   * rebase that fails being undone. A push cancelled before git sent the whole commit leaves the
   * remote as it was, the commit being dropped by the next sync; once it is sent, the push runs to
   * its end, the remote then deciding alone whether it takes it.
   * @param message The message of the commit.
   * @param onWritten Told the bytes git reports as written to the remote, as it writes them, and
   * whether it wrote them all.
   * @param signal Cancels the commit, and the push until git sent the whole commit.
   */
  private async commitAndPush (message: string, onWritten?: (bytes: number, all: boolean) => void, signal?: AbortSignal): Promise<void> {
    const staged = await execFileAsync('git', ['-C', this._folder, 'diff', '--cached', '--quiet']).then(() => false, () => true)
    if (!staged) {
      return
    }
    await this.git([...(await this.identity()), 'commit', '-q', '-m', message], undefined, signal)
    const push = ['push', '--progress', 'origin', `HEAD:${this._settings.branch}`]
    let sent = false
    /**
     * Reports the bytes of a "Writing objects" progress line of git, and whether git wrote them all.
     * @param line A complete line of the error output of git.
     */
    const onLine = (line: string): void => {
      const written = WRITTEN_PATTERN.exec(line)
      sent ||= SENT_ALL.test(line)
      if (written) {
        onWritten?.(Math.round(Number(written[1]) * UNIT_BYTES[written[2]]), WRITTEN_ALL.test(line))
      }
    }
    const pushing = new AbortController()
    /**
     * Stops the push once it is cancelled, unless git already sent the whole commit.
     */
    const cancel = (): void => {
      if (!sent) {
        pushing.abort(signal?.reason)
      }
    }
    signal?.throwIfAborted()
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      await this.git(push, lineReader(onLine), pushing.signal)
    } catch (error) {
      if (pushing.signal.aborted) {
        throw error
      }
      await this.git(['fetch', '-q', 'origin', this._settings.branch], undefined, signal)
      await this.git([...(await this.identity()), 'rebase', '-q', `origin/${this._settings.branch}`], undefined, signal).catch(async (failure: unknown) => {
        await this.git(['rebase', '--abort']).catch(() => undefined)
        throw failure
      })
      signal?.throwIfAborted()
      sent = false
      await this.git(push, lineReader(onLine), pushing.signal)
    } finally {
      signal?.removeEventListener('abort', cancel)
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
   * Gives the SSH command git runs to reach the remote, failing a connection that cannot be opened
   * or whose server stops answering, unless the developer chose their own, the configuration of the
   * working copy included.
   * @returns The environment variable setting it, none when the developer chose a command.
   */
  private async sshCommand (): Promise<Record<string, string>> {
    if (process.env.GIT_SSH_COMMAND !== undefined || process.env.GIT_SSH !== undefined) {
      return {}
    }
    this._sshCommand ??= execFileAsync('git', ['-C', this._folder, 'config', '--get', 'core.sshCommand']).then(() => ({}), () => ({ GIT_SSH_COMMAND: SSH_COMMAND }))
    return this._sshCommand
  }

  /**
   * Runs git in the working copy, in the C locale so its messages read the same on every machine,
   * never asking for credentials nor running hooks, its HTTP exchanges with the remote failing once
   * they move no data for a while. It ends at most a second after git exited, whatever the programs
   * git started still hold.
   * @param args The arguments of git.
   * @param onStderr Told each piece of the error output as git writes it.
   * @param signal Stops git, which settles only once git exited.
   * @returns The standard output.
   */
  private async git (args: string[], onStderr?: (text: string) => void, signal?: AbortSignal): Promise<string> {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...REMOTE_COMMANDS.has(args[0]) ? await this.sshCommand() : {} }
    signal?.throwIfAborted()
    const run = execFileAsync('git', ['-C', this._folder, ...TRANSPORT_LIMITS, ...NO_HOOKS, ...args], { env, maxBuffer: 64 * 1024 * 1024 })
    const { child } = run
    let grace: NodeJS.Timeout | undefined
    /**
     * Stops reading the output of git, which the programs git started may still hold once it exited.
     */
    const release = (): void => {
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    child.once('exit', () => {
      grace = setTimeout(release, signal?.aborted ? 0 : STDIO_GRACE_MS)
    })
    child.once('close', () => clearTimeout(grace))
    /**
     * Stops git once the operation is cancelled.
     */
    const stop = (): void => {
      child.kill()
      if (child.exitCode !== null || child.signalCode !== null) {
        release()
      }
    }
    signal?.addEventListener('abort', stop, { once: true })
    child.stderr?.on('data', (chunk: Buffer) => onStderr?.(chunk.toString()))
    try {
      const { stdout } = await run
      signal?.throwIfAborted()
      return stdout
    } catch (error) {
      signal?.throwIfAborted()
      const stderr = (error as { stderr?: string }).stderr?.split(/[\r\n]+/).filter(line => line.trim() !== '' && !PROGRESS_LINE.test(line)).join('\n')
      const shown = args.filter((arg, index) => !arg.startsWith('user.') && !(arg === '-c' && args[index + 1]?.startsWith('user.')))
      throw new Error(`git ${shown.join(' ')} failed for ${this._settings.slug}: ${stderr || (error as Error).message}`, { cause: error })
    } finally {
      signal?.removeEventListener('abort', stop)
    }
  }

  /**
   * Runs the operations on the working copy one after the other, whichever backend of the process
   * uses it, and holding a lock that other processes using it wait for. An operation cancelled while
   * it waits gives up at once and never starts.
   * @param task The operation.
   * @param signal Cancels the operation.
   * @returns What the operation gives.
   */
  private async serialize<T> (task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let started = false
    /**
     * Starts the operation once the earlier ones of the process ended and no other process uses the
     * working copy, unless it was cancelled meanwhile.
     * @returns What the operation gives.
     */
    const start = async (): Promise<T> => {
      started = true
      signal?.throwIfAborted()
      return withFileLock(`${this._folder}.lock`, `the working copy of ${this._settings.slug}`, task, WORKING_COPY_WAIT_MS, signal)
    }
    const run = (queues.get(this._folder) ?? Promise.resolve()).then(start, start)
    queues.set(this._folder, run.catch(() => undefined))
    if (!signal) {
      return run
    }
    return new Promise<T>((resolve, reject) => {
      /**
       * Gives up an operation still waiting for the earlier ones of the process.
       */
      const abort = (): void => {
        if (!started) {
          reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
        }
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        abort()
      }
      run.finally(() => signal.removeEventListener('abort', abort)).then(resolve, reject)
    })
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
    const name = createHash('sha256').update(options.slug).digest('hex').slice(0, 16)
    return new GitBackend(options, path.join(context.cacheDir, 'environment', 'git', name), context.cacheDir)
  }
}
