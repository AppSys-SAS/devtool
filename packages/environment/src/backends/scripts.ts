import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { scratchPath } from '../directory.js'
import { type BackendContext, type BackendProblem, type BackendSettings, type BackendType, type EnvironmentBackend, knownSize, lineReader, readText, type RemoteFile, STDIO_GRACE_MS, type TransferOptions, unlessAborted } from './backend.js'

const OPERATIONS = ['list', 'download', 'upload', 'remove'] as const
const ABSENT_EXIT_CODE = 2
const STDERR_TAIL_LENGTH = 2000
const PROGRESS_POLL_MS = 250
const STOP_GRACE_MS = 5000
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
const PROGRESS_LINE = /^progress: (\d+)$/

type Operation = typeof OPERATIONS[number]

/** What a command printed, and how it ended. */
interface CommandResult {
  code: number
  stdout: string
}

/** How a command of an operation runs. */
interface RunOptions {
  /** Whether exit code 2, the file being absent, is an answer rather than a failure. */
  allowAbsent?: boolean
  /** Told the bytes of each `progress: <bytes>` line of the error output. */
  onReported?: (bytes: number) => void
  /** Stops the command and every process it started in its process group. */
  signal?: AbortSignal
}

/** Settings of a backend made of your own commands. */
export interface ScriptsSettings extends BackendSettings {
  type: 'scripts'
  /** Folder the commands run in, relative to the configuration folder. */
  cwd: string
  /** The command of each operation, `%{ADT:PATH}` and `%{ADT:FILE}` replaced, value blocks not read yet. */
  list: string[]
  download: string[]
  /** Null when the backend refuses every push. */
  upload: string[] | null
  /** Null when the backend refuses every push. */
  remove: string[] | null
  /** Environment variables of the commands, value blocks not read yet. */
  env: Record<string, string>
}

/**
 * Sends a signal to the process group a command leads.
 * @param pid The process leading the group, undefined when it never started.
 * @param name The signal.
 * @returns False when there is no such group.
 */
function signalGroup (pid: number | undefined, name: NodeJS.Signals): boolean {
  if (pid === undefined || pid <= 1) {
    return false
  }
  try {
    process.kill(-pid, name)
    return true
  } catch {
    return false
  }
}

/**
 * The process groups of the commands running in sessions of their own, which no terminal reaches:
 * the stop signals of the current process are passed on to them, and they are killed when nothing
 * else handles such a signal or when the current process exits.
 */
class StopGroups {
  private readonly _groups = new Set<number>()
  private _watching = false

  /**
   * Passes a stop signal on to every group; when nothing else handles it, kills them all and lets
   * the current process stop as it would have.
   * @param stopSignal The signal.
   */
  private readonly passOn = (stopSignal: NodeJS.Signals): void => {
    for (const pid of this._groups) {
      signalGroup(pid, stopSignal)
    }
    this.stopWatching()
    if (process.listenerCount(stopSignal) === 0) {
      this.killAll()
      process.kill(process.pid, stopSignal)
    }
  }

  /**
   * Kills every group.
   */
  private readonly killAll = (): void => {
    for (const pid of this._groups) {
      signalGroup(pid, 'SIGKILL')
    }
  }

  /**
   * Starts following a group.
   * @param pid The process leading the group.
   */
  follow (pid: number): void {
    if (this._groups.size === 0) {
      process.on('exit', this.killAll)
    }
    if (!this._watching) {
      for (const stopSignal of STOP_SIGNALS) {
        process.prependListener(stopSignal, this.passOn)
      }
      this._watching = true
    }
    this._groups.add(pid)
  }

  /**
   * Stops following a group once its command ended.
   * @param pid The process leading the group.
   */
  forget (pid: number): void {
    if (this._groups.delete(pid) && this._groups.size === 0) {
      this.stopWatching()
      process.off('exit', this.killAll)
    }
  }

  /**
   * Stops listening to the stop signals of the current process.
   */
  private stopWatching (): void {
    for (const stopSignal of STOP_SIGNALS) {
      process.off(stopSignal, this.passOn)
    }
    this._watching = false
  }
}

const stopGroups = new StopGroups()

/**
 * Reads a command: a non-empty list of texts or numbers.
 * @param value The raw setting.
 * @returns The command, null when the setting is not one.
 */
function readCommand (value: unknown): string[] | null {
  return Array.isArray(value) && value.length > 0 && value.every(arg => typeof arg === 'string' || typeof arg === 'number') ? value.map(String) : null
}

/**
 * Reads the files a `list` command printed, `{ "files": [ { "path", "size", "updatedAt", "version" } ] }`,
 * a missing or null size standing for one the storage does not give.
 * @param output The standard output of the command.
 * @returns The files.
 */
function parseListing (output: string): RemoteFile[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error(`the list command printed no JSON: ${output.slice(0, 200)}`)
  }
  const files = (parsed as { files?: unknown } | null)?.files
  if (!Array.isArray(files)) {
    throw new Error('the list command must print { "files": [ ... ] }')
  }
  return files.map((file: unknown) => {
    const entry = (typeof file === 'object' && file !== null ? file : {}) as Record<string, unknown>
    const updatedAt = typeof entry.updatedAt === 'string' ? new Date(entry.updatedAt) : null
    const size = entry.size ?? null
    if (typeof entry.path !== 'string' || (size !== null && typeof size !== 'number') || updatedAt === null || Number.isNaN(updatedAt.getTime())) {
      throw new Error(`the list command printed an invalid file: ${JSON.stringify(file)}, expected { "path", "updatedAt" } and a numeric "size" when known`)
    }
    return { path: entry.path, size: knownSize(size), updatedAt, version: typeof entry.version === 'string' ? entry.version : updatedAt.toISOString() }
  })
}

/**
 * A backend running your own commands for each operation.
 */
class ScriptsBackend implements EnvironmentBackend {
  private readonly _resolved = new Map<Operation | 'env', Promise<unknown>>()

  /**
   * @param _settings The settings of the backend.
   * @param _context What the devtool provides.
   */
  constructor (private readonly _settings: ScriptsSettings, private readonly _context: BackendContext) {}

  /**
   * Lists the stored files with the `list` command.
   * @param signal Stops the command.
   * @returns The files.
   */
  async list (signal?: AbortSignal): Promise<RemoteFile[] | null> {
    const { stdout } = await this.run('list', '', '', { signal })
    return parseListing(stdout)
  }

  /**
   * Opens a stored file, written by the `download` command to a temporary file removed once read,
   * or left to the next process when it cannot be removed.
   * @param filePath The path of the file.
   * @param options Follows the size of the temporary file while the command writes it, or the bytes
   * it reports with `progress: <bytes>` lines on its error output, and stops the command.
   * @returns Its content, or null when the command exits with code 2.
   */
  async download (filePath: string, { onProgress, signal }: TransferOptions = {}): Promise<Readable | null> {
    const temporary = await scratchPath(this._context.cacheDir, 'download')
    let running = true
    /**
     * Tells the bytes the command moved while it runs.
     * @param bytes The bytes moved.
     */
    const moved = (bytes: number): void => {
      if (running) {
        onProgress?.(bytes, null)
      }
    }
    const poll = setInterval(() => {
      fs.stat(temporary).then(({ size }) => moved(size), () => undefined)
    }, PROGRESS_POLL_MS)
    try {
      const { code } = await this.run('download', filePath, temporary, { allowAbsent: true, onReported: moved, signal }).finally(() => {
        running = false
      })
      if (code === ABSENT_EXIT_CODE) {
        await fs.rm(temporary, { force: true })
        return null
      }
      onProgress?.((await fs.stat(temporary)).size, null)
      const content = createReadStream(temporary)
      content.on('close', () => {
        fs.rm(temporary, { force: true }).catch(() => undefined)
      })
      return content
    } catch (error) {
      await fs.rm(temporary, { force: true })
      throw error
    } finally {
      clearInterval(poll)
    }
  }

  /**
   * Stores a local file with the `upload` command, which may report the bytes it sent with
   * `progress: <bytes>` lines on its error output.
   * @param filePath The path of the file in the backend.
   * @param localFile The local file.
   * @param _mediaType Unused, the command choosing how the file is stored.
   * @param options Follows the bytes the command reports, the size of the file standing for the
   * total, and stops the command with the processes it started.
   */
  async upload (filePath: string, localFile: string, _mediaType: string, { onProgress, signal }: TransferOptions = {}): Promise<void> {
    const { size } = await fs.stat(localFile)
    await this.run('upload', filePath, localFile, { onReported: bytes => onProgress?.(bytes, size), signal })
  }

  /**
   * Deletes a stored file with the `remove` command.
   * @param filePath The path of the file.
   */
  async remove (filePath: string): Promise<void> {
    await this.run('remove', filePath, '')
  }

  /**
   * Keeps no connection open.
   */
  async close (): Promise<void> {
    await Promise.resolve()
  }

  /**
   * Reads the value blocks of the environment and of the commands that read the files, which may
   * ask the developer to approve their reading; those of the other commands are read when used.
   */
  async prepare (): Promise<void> {
    await Promise.all([this.env(), this.command('list'), this.command('download')])
  }

  /**
   * Gives the environment variables of the commands, their value blocks read once.
   * @returns The variables.
   */
  private async env (): Promise<Record<string, string>> {
    return this.once('env', async () => {
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(this._settings.env)) {
        env[key] = await this._context.resolve(value)
      }
      return env
    })
  }

  /**
   * Gives the command of an operation, its value blocks read once.
   * @param operation The operation.
   * @returns The command, null when undeclared.
   */
  private async command (operation: Operation): Promise<string[] | null> {
    const command = this._settings[operation]
    return this.once(operation, async () => command && Promise.all(command.map(async arg => this._context.resolve(arg))))
  }

  /**
   * Reads values once, read again after a failure.
   * @param key What the values are.
   * @param read Reads them.
   * @returns The values.
   */
  private async once<T> (key: Operation | 'env', read: () => Promise<T>): Promise<T> {
    let values = this._resolved.get(key) as Promise<T> | undefined
    if (!values) {
      values = read()
      this._resolved.set(key, values)
      values.catch(() => this._resolved.delete(key))
    }
    return values
  }

  /**
   * Runs the command of an operation, its value blocks read and `%{ADT:PATH}` and `%{ADT:FILE}`
   * replaced, in a process group of its own that the stop signals of the current process reach. A
   * command ends once its process exits, at once when stopped, else once its output is read or a
   * short delay later, whatever processes outside its group still hold; the processes it left in
   * its group are then killed.
   * @param operation The operation.
   * @param filePath The path of the file in the backend.
   * @param localFile The local file the command reads or writes.
   * @param options Whether exit code 2 is an answer, who is told the progress lines, and what stops the command.
   * @returns What the command printed and its exit code.
   */
  private async run (operation: Operation, filePath: string, localFile: string, { allowAbsent = false, onReported, signal }: RunOptions = {}): Promise<CommandResult> {
    const [command, values] = await unlessAborted(Promise.all([this.command(operation), this.env()]), signal)
    if (command === null) {
      throw new Error(`${this._settings.slug} declares no ${operation} command`)
    }
    const args = command.map(arg => arg.replaceAll('%{ADT:PATH}', filePath).replaceAll('%{ADT:FILE}', localFile))
    const env: Record<string, string> = { ...process.env as Record<string, string>, ...values }
    const cwd = path.resolve(this._context.configFolder, this._settings.cwd)
    const result = await new Promise<CommandResult & { stderr: string }>((resolve, reject) => {
      signal?.throwIfAborted()
      const child = spawn(args[0], args.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let settled = false
      let exited = false
      let exitCode: number | null = null
      let stopped = false
      let forced: NodeJS.Timeout | undefined
      let drained: NodeJS.Timeout | undefined
      /**
       * Ends the command once, killing what it left in its process group, with what it printed, or
       * as stopped when it was stopped before it exited.
       * @param code The exit code of the command.
       */
      const settle = (code: number | null): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(drained)
        clearTimeout(forced)
        signal?.removeEventListener('abort', stop)
        signalGroup(child.pid, 'SIGKILL')
        if (child.pid !== undefined) {
          stopGroups.forget(child.pid)
        }
        const result = { code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }
        child.stdout.destroy()
        child.stderr.destroy()
        if (stopped) {
          reject(new Error(`${operation} of ${this._settings.slug} stopped`))
          return
        }
        resolve(result)
      }
      /**
       * Stops the process group of the command, killing it when it outlives a grace delay, or ends
       * the command at once with its exit code when its process already exited.
       */
      const stop = (): void => {
        if (exited) {
          settle(exitCode)
          return
        }
        stopped = true
        if (signalGroup(child.pid, 'SIGTERM')) {
          forced = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), STOP_GRACE_MS)
        }
      }
      if (child.pid !== undefined) {
        stopGroups.follow(child.pid)
      }
      signal?.addEventListener('abort', stop, { once: true })
      const readLine = lineReader(line => {
        const reported = PROGRESS_LINE.exec(line.trim())
        if (reported) {
          onReported?.(Number(reported[1]))
        }
      })
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk)
        readLine(chunk.toString('utf8'))
      })
      child.on('error', error => {
        if (settled) {
          return
        }
        settled = true
        signal?.removeEventListener('abort', stop)
        reject(new Error(`${operation} of ${this._settings.slug}: cannot run ${args[0]}: ${error.message}`))
      })
      child.on('exit', code => {
        exited = true
        exitCode = code
        drained = setTimeout(() => settle(code), stopped ? 0 : STDIO_GRACE_MS)
      })
      child.on('close', code => settle(code))
    })
    if (result.code !== 0 && !(allowAbsent && result.code === ABSENT_EXIT_CODE)) {
      const messages = result.stderr.split('\n').filter(line => !PROGRESS_LINE.test(line.trim())).join('\n')
      throw new Error(`${operation} of ${this._settings.slug} failed (exit ${result.code}): ${messages.trim().slice(-STDERR_TAIL_LENGTH)}`)
    }
    return result
  }
}

/** A backend whose operations are your own commands, for any storage the other backends do not reach. */
export const scripts: BackendType<ScriptsSettings> = {
  type: 'scripts',

  readOptions (section, shared, setting) {
    const problems: BackendProblem[] = []
    const commands = Object.fromEntries(OPERATIONS.map(operation => [operation, readCommand(section[operation])]))
    const optional = new Set<Operation>(shared.groups.push === false ? ['upload', 'remove'] : [])
    for (const operation of OPERATIONS) {
      if (commands[operation] === null && !(optional.has(operation) && section[operation] === undefined)) {
        problems.push({ setting: `${setting}.${operation}`, message: 'must be a command: a list of texts' })
      }
    }
    const env = typeof section.env === 'object' && section.env !== null && !Array.isArray(section.env) ? section.env as Record<string, unknown> : {}
    if (section.env !== undefined && (env !== section.env || Object.values(env).some(value => typeof value !== 'string'))) {
      problems.push({ setting: `${setting}.env`, message: 'must be a map of texts' })
    }
    if (problems.length > 0) {
      return { options: null, problems }
    }
    return {
      options: {
        ...shared,
        type: 'scripts',
        cwd: readText(section.cwd) ?? '.',
        list: commands.list!,
        download: commands.download!,
        upload: commands.upload,
        remove: commands.remove,
        env: env as Record<string, string>
      },
      problems
    }
  },

  create (options, context) {
    return new ScriptsBackend(options, context)
  }
}
