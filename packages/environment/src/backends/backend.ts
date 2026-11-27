import { type Readable, Transform, type TransformCallback } from 'node:stream'
import type { AuthOptions } from '@appsys-sas/devtool-auth'
import type { TransferAccess } from '../access.js'
import type { EncryptionSettings } from './encryption.js'

/** A file stored by a backend. */
export interface RemoteFile {
  /** Path of the file, relative to the root of the backend. */
  path: string
  /** Size of the file as the environment reads it, in bytes. */
  size: number
  /** Last change of the stored file. */
  updatedAt: Date
  /** Changes whenever the stored file is written, and only then. */
  version: string
}

/**
 * Reports how much of a file a transfer moved.
 * @param done The bytes moved so far.
 * @param total The size of the file, null when the transfer does not know it.
 */
export type TransferProgress = (done: number, total: number | null) => void

/** How a caller follows a transfer of a file. */
export interface TransferOptions {
  /** Told the bytes moved as they move. */
  onProgress?: TransferProgress
  /** Abandons a download before its content is opened; the stream it gives is aborted by the caller. */
  signal?: AbortSignal
}

/** Where the files of the environment are stored, read and written. */
export interface EnvironmentBackend {
  /**
   * Lists the stored files.
   * @returns The files, or null when the backend cannot list them.
   */
  list: () => Promise<RemoteFile[] | null>
  /**
   * Opens a stored file.
   * @param path The path of the file.
   * @param options Follows the bytes received, and abandons the request.
   * @returns Its content, or null when the file does not exist.
   */
  download: (path: string, options?: TransferOptions) => Promise<Readable | null>
  /**
   * Stores a local file, replacing the stored one.
   * @param path The path of the file in the backend.
   * @param localFile The local file.
   * @param mediaType The media type of the file.
   * @param options Follows the bytes sent.
   */
  upload: (path: string, localFile: string, mediaType: string, options?: TransferOptions) => Promise<void>
  /**
   * Deletes a stored file; a missing file counts as deleted.
   * @param path The path of the file.
   */
  remove: (path: string) => Promise<void>
  /**
   * Releases the connections the backend keeps.
   */
  close: () => Promise<void>
}

/** Settings every backend shares. */
export interface BackendSettings {
  /** The kind of backend. */
  type: string
  /** The name of the backend in `environment.backends`, the one items give in `backend`. */
  slug: string
  /** Whether items naming no backend use this one. */
  default: boolean
  /** The secret encrypting every file before it reaches the backend, null to store the files as they are. */
  encryption: EncryptionSettings | null
  /** Who may pull and push the items of the backend, unless an item names its own groups. */
  groups: TransferAccess
}

/** A problem of the settings of a backend. */
export interface BackendProblem {
  /** Path of the setting, such as `environment.backends.team.url`. */
  setting: string
  message: string
}

/** What the backends need from the devtool running them. */
export interface BackendContext {
  /**
   * Replaces the value blocks of a setting (`{{ op://... }}`, `{{ file://... }}`, `{{ $(...) }}`, `{{ auth://... }}`).
   * @param text The setting.
   * @returns The setting with the values read.
   */
  resolve: (text: string) => Promise<string>
  /**
   * Asks the developer for a secret, such as the password of encrypted files.
   * @param label What the secret unlocks.
   * @returns The secret typed.
   */
  askSecret: (label: string) => Promise<string>
  /** Folder of what the devtool keeps between runs, such as the clones of git backends. */
  cacheDir: string
  /** Folder of the devtool configuration, relative paths of the settings being resolved from it. */
  configFolder: string
  /** The identity provider signing the developers in, null when the configuration declares none. */
  auth: AuthOptions | null
}

/** One kind of backend: how its settings read and how it connects. */
export interface BackendType<T extends BackendSettings> {
  readonly type: T['type']
  /**
   * Reads the settings proper to this kind of backend.
   * @param section The raw settings of the backend.
   * @param shared The settings every backend shares, already read.
   * @param setting Path of the settings of the backend, for the problems.
   * @returns The settings, null when they are incomplete, and their problems.
   */
  readOptions: (section: Record<string, unknown>, shared: BackendSettings, setting: string) => { options: T | null, problems: BackendProblem[] }
  /**
   * Creates the backend; it connects and reads its secrets on its first use.
   * @param options The settings.
   * @param context What the devtool provides.
   * @returns The backend.
   */
  create: (options: T, context: BackendContext) => EnvironmentBackend
}

/**
 * Builds a stream counting the bytes passing through it, failing at its end when it did not carry an exact length.
 * @param expected The expected length in bytes, or null to accept any.
 * @param onProgress Told the bytes counted after each chunk.
 * @returns The transform counting the bytes.
 */
export function byteCounter (expected: number | null, onProgress?: TransferProgress): Transform {
  let received = 0
  return new Transform({
    transform (chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      received += chunk.length
      onProgress?.(received, expected)
      callback(null, chunk)
    },
    flush (callback: TransformCallback): void {
      callback(expected !== null && received !== expected ? new Error(`incomplete transfer: ${received} of ${expected} bytes`) : null)
    }
  })
}

/**
 * Builds a reader of text written in pieces, such as the error output of a command, telling each
 * line once it is complete, a line ending at a carriage return or a newline.
 * @param onLine Told each complete line.
 * @returns Takes each piece of text as it comes.
 */
export function lineReader (onLine: (line: string) => void): (text: string) => void {
  let partial = ''
  return text => {
    const lines = (partial + text).split(/[\r\n]/)
    partial = lines.pop() ?? ''
    for (const line of lines) {
      onLine(line)
    }
  }
}

/**
 * Reads a setting that must hold a non-blank text.
 * @param value The raw setting.
 * @returns The text, null when the setting is not a string or is blank.
 */
export function readText (value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}
