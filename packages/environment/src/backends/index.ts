import { readTransferGroups } from '../access.js'
import type { BackendContext, BackendProblem, BackendSettings, BackendType, EnvironmentBackend } from './backend.js'
import { cdn, type CdnSettings } from './cdn.js'
import { encrypted, EncryptionSecret, readEncryption } from './encryption.js'
import { git, type GitSettings } from './git.js'
import { s3, type S3Settings } from './s3.js'
import { scripts, type ScriptsSettings } from './scripts.js'
import { sftp, type SftpSettings } from './sftp.js'

export { BACKEND_IDLE_MS, DEVELOPER_ANSWER_MS } from './backend.js'
export type { BackendContext, BackendProblem, EnvironmentBackend, RemoteFile, TransferOptions, TransferProgress } from './backend.js'
export { CdnRequestError } from './cdn.js'
export { encrypted, EncryptionSecret, type EncryptionSettings, readEncryption } from './encryption.js'

/** Settings of a backend of the environment, by kind. */
export type BackendOptions = CdnSettings | S3Settings | SftpSettings | GitSettings | ScriptsSettings

const BACKEND_TYPES: { [T in BackendOptions['type']]: BackendType<Extract<BackendOptions, { type: T }>> } = { cdn, s3, sftp, git, scripts }

/** Kinds of backend `environment.backends` accepts. */
export const BACKEND_KINDS = Object.keys(BACKEND_TYPES)

/**
 * Reads `environment.backends`, a map of backends by name, each with its `type`, `default`, `encryption` and `groups`.
 * @param section The raw `environment.backends` section.
 * @returns The backends in their declaration order, the name of the default one, and the problems of the section.
 */
export function readBackends (section: unknown): { backends: BackendOptions[], defaultBackend: string | null, problems: BackendProblem[] } {
  const problems: BackendProblem[] = []
  if (section === undefined) {
    return { backends: [], defaultBackend: null, problems }
  }
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    return { backends: [], defaultBackend: null, problems: [{ setting: 'environment.backends', message: 'must be a map of backends by name' }] }
  }

  const backends: BackendOptions[] = []
  for (const [slug, raw] of Object.entries(section)) {
    const setting = `environment.backends.${slug}`
    const record = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : null
    if (record === null) {
      problems.push({ setting, message: 'must be a map of settings' })
      continue
    }
    if (typeof record.type !== 'string' || !Object.hasOwn(BACKEND_TYPES, record.type)) {
      problems.push({ setting: `${setting}.type`, message: `must be one of ${BACKEND_KINDS.join(', ')}` })
      continue
    }
    if (record.default !== undefined && typeof record.default !== 'boolean') {
      problems.push({ setting: `${setting}.default`, message: 'must be true or false' })
    }
    const { encryption, problems: encryptionProblems } = readEncryption(record.encryption, `${setting}.encryption`)
    problems.push(...encryptionProblems)
    const { groups, problems: groupProblems } = readTransferGroups(record.groups)
    problems.push(...groupProblems.map(message => ({ setting: `${setting}.groups`, message })))
    const shared: BackendSettings = { type: record.type, slug, default: record.default === true, encryption, groups }
    const type = BACKEND_TYPES[record.type as BackendOptions['type']] as BackendType<BackendOptions>
    const read = type.readOptions(record, shared, setting)
    problems.push(...read.problems)
    if (read.options) {
      backends.push(read.options)
    }
  }

  const defaults = backends.filter(backend => backend.default)
  if (defaults.length > 1) {
    problems.push({ setting: 'environment.backends', message: `several backends are the default one, ${defaults[0].slug} is used` })
  }
  return { backends, defaultBackend: defaults[0]?.slug ?? backends[0]?.slug ?? null, problems }
}

/**
 * Creates every backend of the environment.
 * @param backends The settings of the backends.
 * @param context What the devtool provides.
 * @returns The backends, by name.
 */
export function createBackends (backends: BackendOptions[], context: BackendContext): Map<string, EnvironmentBackend> {
  return new Map(backends.map(options => [options.slug, createBackend(options, context)]))
}

/**
 * Creates a backend, encrypting its files when it declares an encryption key.
 * @param options The settings of the backend.
 * @param context What the devtool provides.
 * @returns The backend.
 */
export function createBackend (options: BackendOptions, context: BackendContext): EnvironmentBackend {
  const backend = (BACKEND_TYPES[options.type] as BackendType<BackendOptions>).create(options, context)
  return options.encryption === null ? backend : encrypted(backend, new EncryptionSecret(options.encryption, context, `the files of the backend ${options.slug}`))
}
