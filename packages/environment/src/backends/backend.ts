import type { Readable } from 'node:stream'
import type { AuthOptions } from '@appsys-sas/devtool-auth'
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
   * @returns Its content, or null when the file does not exist.
   */
  download: (path: string) => Promise<Readable | null>
  /**
   * Stores a local file, replacing the stored one.
   * @param path The path of the file in the backend.
   * @param localFile The local file.
   * @param mediaType The media type of the file.
   */
  upload: (path: string, localFile: string, mediaType: string) => Promise<void>
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
 * Reads a setting that must hold a non-blank text.
 * @param value The raw setting.
 * @returns The text, null when the setting is not a string or is blank.
 */
export function readText (value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}
