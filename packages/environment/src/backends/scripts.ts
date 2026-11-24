import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { type BackendContext, type BackendProblem, type BackendSettings, type BackendType, type EnvironmentBackend, readText, type RemoteFile } from './backend.js'

const OPERATIONS = ['list', 'download', 'upload', 'remove'] as const
const ABSENT_EXIT_CODE = 2
const STDERR_TAIL_LENGTH = 2000

type Operation = typeof OPERATIONS[number]

/** What a command printed, and how it ended. */
interface CommandResult {
  code: number
  stdout: string
}

/** Settings of a backend made of your own commands. */
export interface ScriptsSettings extends BackendSettings {
  type: 'scripts'
  /** Folder the commands run in, relative to the configuration folder. */
  cwd: string
  /** The command of each operation, `%{ADT:PATH}` and `%{ADT:FILE}` replaced, value blocks not read yet. */
  list: string[]
  download: string[]
  upload: string[]
  remove: string[]
  /** Environment variables of the commands, value blocks not read yet. */
  env: Record<string, string>
}

/**
 * Reads a command: a non-empty list of texts or numbers.
 * @param value The raw setting.
 * @returns The command, null when the setting is not one.
 */
function readCommand (value: unknown): string[] | null {
  return Array.isArray(value) && value.length > 0 && value.every(arg => typeof arg === 'string' || typeof arg === 'number') ? value.map(String) : null
}

/**
 * Reads the files a `list` command printed, `{ "files": [ { "path", "size", "updatedAt", "version" } ] }`.
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
    if (typeof entry.path !== 'string' || typeof entry.size !== 'number' || updatedAt === null || Number.isNaN(updatedAt.getTime())) {
      throw new Error(`the list command printed an invalid file: ${JSON.stringify(file)}, expected { "path", "size", "updatedAt" }`)
    }
    return { path: entry.path, size: entry.size, updatedAt, version: typeof entry.version === 'string' ? entry.version : updatedAt.toISOString() }
  })
}

/**
 * A backend running your own commands for each operation.
 */
class ScriptsBackend implements EnvironmentBackend {
  /**
   * @param _settings The settings of the backend.
   * @param _context What the devtool provides.
   */
  constructor (private readonly _settings: ScriptsSettings, private readonly _context: BackendContext) {}

  /**
   * Lists the stored files with the `list` command.
   * @returns The files.
   */
  async list (): Promise<RemoteFile[] | null> {
    const { stdout } = await this.run('list', '', '')
    return parseListing(stdout)
  }

  /**
   * Opens a stored file, written by the `download` command to a temporary file removed once read.
   * @param filePath The path of the file.
   * @returns Its content, or null when the command exits with code 2.
   */
  async download (filePath: string): Promise<Readable | null> {
    const temporary = path.join(os.tmpdir(), `devtool-download-${randomUUID()}`)
    try {
      const { code } = await this.run('download', filePath, temporary, true)
      if (code === ABSENT_EXIT_CODE) {
        await fs.rm(temporary, { force: true })
        return null
      }
      const content = createReadStream(temporary)
      content.on('close', () => {
        void fs.rm(temporary, { force: true })
      })
      return content
    } catch (error) {
      await fs.rm(temporary, { force: true })
      throw error
    }
  }

  /**
   * Stores a local file with the `upload` command.
   * @param filePath The path of the file in the backend.
   * @param localFile The local file.
   */
  async upload (filePath: string, localFile: string): Promise<void> {
    await this.run('upload', filePath, localFile)
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
   * Runs the command of an operation, its value blocks read and `%{ADT:PATH}` and `%{ADT:FILE}` replaced.
   * @param operation The operation.
   * @param filePath The path of the file in the backend.
   * @param localFile The local file the command reads or writes.
   * @param allowAbsent Whether exit code 2, the file being absent, is an answer rather than a failure.
   * @returns What the command printed and its exit code.
   */
  private async run (operation: Operation, filePath: string, localFile: string, allowAbsent = false): Promise<CommandResult> {
    const args = await Promise.all(this._settings[operation].map(async arg =>
      (await this._context.resolve(arg)).replaceAll('%{ADT:PATH}', filePath).replaceAll('%{ADT:FILE}', localFile)))
    const env: Record<string, string> = { ...process.env as Record<string, string> }
    for (const [key, value] of Object.entries(this._settings.env)) {
      env[key] = await this._context.resolve(value)
    }
    const cwd = path.resolve(this._context.configFolder, this._settings.cwd)
    const result = await new Promise<CommandResult & { stderr: string }>((resolve, reject) => {
      const child = spawn(args[0], args.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.on('error', error => {
        reject(new Error(`${operation} of ${this._settings.slug}: cannot run ${args[0]}: ${error.message}`))
      })
      child.on('close', code => {
        resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
      })
    })
    if (result.code !== 0 && !(allowAbsent && result.code === ABSENT_EXIT_CODE)) {
      throw new Error(`${operation} of ${this._settings.slug} failed (exit ${result.code}): ${result.stderr.trim().slice(-STDERR_TAIL_LENGTH)}`)
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
    for (const operation of OPERATIONS) {
      if (commands[operation] === null) {
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
        upload: commands.upload!,
        remove: commands.remove!,
        env: env as Record<string, string>
      },
      problems
    }
  },

  create (options, context) {
    return new ScriptsBackend(options, context)
  }
}
