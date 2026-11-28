import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import { pipeline as streamPipeline, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { temporaryPathOf } from '../directory.js'
import type { BackendContext, BackendProblem, EnvironmentBackend, RemoteFile, TransferOptions, TransferProgress } from './backend.js'

const MAGIC = Buffer.from('ADTE')
const VERSION = 1
const SALT_LENGTH = 32
const HEADER_LENGTH = MAGIC.length + 1 + SALT_LENGTH
const CHUNK_LENGTH = 64 * 1024
const TAG_LENGTH = 16
const SEALED_CHUNK_LENGTH = CHUNK_LENGTH + TAG_LENGTH
const KEY_INFO = 'devtool-environment-v1'
const SCRYPT_OPTIONS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

/** Where the secret encrypting files comes from: a key, a password, or a password asked when needed. */
export type EncryptionSettings
  = | { key: string }
    | { password: string }
    | { prompt: true }

/** Gives the key of one file from the salt of the file. */
type FileKey = (salt: Buffer) => Buffer

/**
 * Reads an `encryption` setting: `{ key }` (32 bytes in base64), `{ password }` or `{ prompt: true }`,
 * `key` and `password` reading value blocks.
 * @param value The raw setting.
 * @param setting Path of the setting, for the problems.
 * @returns The settings, null when the setting is missing or invalid, and its problems.
 */
export function readEncryption (value: unknown, setting: string): { encryption: EncryptionSettings | null, problems: BackendProblem[] } {
  if (value === undefined) {
    return { encryption: null, problems: [] }
  }
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const sources = ['key', 'password', 'prompt'].filter(source => record[source] !== undefined)
  if (sources.length === 1 && typeof record.key === 'string' && record.key.trim() !== '') {
    return { encryption: { key: record.key }, problems: [] }
  }
  if (sources.length === 1 && typeof record.password === 'string' && record.password !== '') {
    return { encryption: { password: record.password }, problems: [] }
  }
  if (sources.length === 1 && record.prompt === true) {
    return { encryption: { prompt: true }, problems: [] }
  }
  return { encryption: null, problems: [{ setting, message: 'must be { key } (32 bytes in base64), { password } or { prompt: true }' }] }
}

/**
 * Reads an encryption key given in base64.
 * @param text The key, 32 bytes in base64.
 * @returns The key.
 */
export function readEncryptionKey (text: string): Buffer {
  const key = Buffer.from(text.trim(), 'base64')
  if (key.length !== 32) {
    throw new Error('the encryption key must be 32 bytes in base64, such as the output of `openssl rand -base64 32`')
  }
  return key
}

/**
 * Gives the size of a file once decrypted, from its encrypted size.
 * @param sealedSize The size of the encrypted file.
 * @returns The size of its content, null when no encrypted file has this size.
 */
export function plainLengthOf (sealedSize: number): number | null {
  const body = sealedSize - HEADER_LENGTH
  if (body < TAG_LENGTH) {
    return null
  }
  const chunks = Math.ceil(body / SEALED_CHUNK_LENGTH)
  return body - (chunks - 1) * SEALED_CHUNK_LENGTH >= TAG_LENGTH ? body - chunks * TAG_LENGTH : null
}

/**
 * Gives how much content the first bytes of an encrypted file carry, the header and the tags left
 * out; for the whole file, its size once decrypted.
 * @param sealedBytes The bytes of the encrypted file.
 * @returns The bytes of content they carry.
 */
export function plainBytesOf (sealedBytes: number): number {
  const body = Math.max(0, sealedBytes - HEADER_LENGTH)
  const chunks = Math.floor(body / SEALED_CHUNK_LENGTH)
  return chunks * CHUNK_LENGTH + Math.max(0, body - chunks * SEALED_CHUNK_LENGTH - TAG_LENGTH)
}

/**
 * Turns the progress of an encrypted file into the progress of its content.
 * @param onProgress Told the progress of the content.
 * @returns Takes the progress of the encrypted file.
 */
function plainProgress (onProgress: TransferProgress | undefined): TransferProgress | undefined {
  return onProgress && ((done, total) => onProgress(plainBytesOf(done), total === null ? null : plainBytesOf(total)))
}

/**
 * Builds the nonce of a chunk: its index, and whether it is the last one, so chunks can be neither
 * reordered nor dropped.
 * @param index The index of the chunk.
 * @param last Whether it ends the file.
 * @returns The nonce.
 */
function nonceOf (index: number, last: boolean): Buffer {
  const nonce = Buffer.alloc(12)
  nonce.writeBigUInt64BE(BigInt(index), 0)
  nonce[11] = last ? 1 : 0
  return nonce
}

/**
 * Gives the key of each file for a key of 32 bytes.
 * @param key The key.
 * @returns The key of a file, from its salt.
 */
export function keyFileKey (key: Buffer): FileKey {
  return salt => Buffer.from(hkdfSync('sha256', key, salt, KEY_INFO, 32))
}

/**
 * Gives the key of each file for a password, stretched with scrypt and the salt of the file.
 * @param password The password.
 * @returns The key of a file, from its salt.
 */
export function passwordFileKey (password: string): FileKey {
  return salt => keyFileKey(scryptSync(password, salt, 32, SCRYPT_OPTIONS))(salt)
}

/**
 * Encrypts a content chunk by chunk with AES-256-GCM, the path of the file authenticated with each chunk.
 * @param source The content.
 * @param fileKey Gives the key of the file from its salt.
 * @param filePath The path of the file in the backend.
 * @yields The encrypted file.
 */
export async function* encrypt (source: AsyncIterable<Buffer>, fileKey: FileKey, filePath: string): AsyncGenerator<Buffer> {
  const salt = randomBytes(SALT_LENGTH)
  const key = fileKey(salt)
  yield Buffer.concat([MAGIC, Buffer.from([VERSION]), salt])

  let pending = Buffer.alloc(0)
  let index = 0
  const seal = (chunk: Buffer, last: boolean): Buffer => {
    const cipher = createCipheriv('aes-256-gcm', key, nonceOf(index++, last))
    cipher.setAAD(Buffer.from(filePath))
    return Buffer.concat([cipher.update(chunk), cipher.final(), cipher.getAuthTag()])
  }
  for await (const data of source) {
    pending = Buffer.concat([pending, data])
    while (pending.length > CHUNK_LENGTH) {
      yield seal(pending.subarray(0, CHUNK_LENGTH), false)
      pending = pending.subarray(CHUNK_LENGTH)
    }
  }
  yield seal(pending, true)
}

/** Raised when a chunk of an encrypted file does not open with its key: another secret, or a damaged file. */
export class WrongSecretError extends Error {
  /**
   * @param message - What could not be decrypted.
   */
  constructor (message: string) {
    super(message)
    this.name = 'WrongSecretError'
  }
}

/**
 * Decrypts a file written by `encrypt`, failing when it was changed, cut, or encrypted with another
 * secret or for another path.
 * @param source The encrypted file.
 * @param fileKey Gives the key of the file from its salt.
 * @param filePath The path of the file in the backend.
 * @yields The content.
 */
export async function* decrypt (source: AsyncIterable<Buffer>, fileKey: FileKey, filePath: string): AsyncGenerator<Buffer> {
  let pending = Buffer.alloc(0)
  let key: Buffer | null = null
  let index = 0
  const open = (sealed: Buffer, last: boolean, secret: Buffer): Buffer => {
    const decipher = createDecipheriv('aes-256-gcm', secret, nonceOf(index++, last))
    decipher.setAAD(Buffer.from(filePath))
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_LENGTH))
    try {
      return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_LENGTH)), decipher.final()])
    } catch {
      throw new WrongSecretError(`cannot decrypt ${filePath}: wrong encryption secret, or damaged file`)
    }
  }
  for await (const data of source) {
    pending = Buffer.concat([pending, data])
    if (key === null) {
      if (pending.length < HEADER_LENGTH) {
        continue
      }
      if (!pending.subarray(0, MAGIC.length).equals(MAGIC) || pending[MAGIC.length] !== VERSION) {
        throw new Error(`cannot decrypt ${filePath}: not a file encrypted by the devtool`)
      }
      key = fileKey(pending.subarray(MAGIC.length + 1, HEADER_LENGTH))
      pending = pending.subarray(HEADER_LENGTH)
    }
    while (pending.length > SEALED_CHUNK_LENGTH) {
      yield open(pending.subarray(0, SEALED_CHUNK_LENGTH), false, key)
      pending = pending.subarray(SEALED_CHUNK_LENGTH)
    }
  }
  if (key === null || pending.length < TAG_LENGTH) {
    throw new Error(`cannot decrypt ${filePath}: the file is cut short`)
  }
  yield open(pending, true, key)
}

/**
 * The secret of some encrypted files, read on first use: its key or password read with the value
 * blocks, or a password asked to the developer and asked again after a wrong one.
 */
export class EncryptionSecret {
  private _fileKey: Promise<FileKey> | null = null

  /**
   * @param _settings Where the secret comes from.
   * @param _context Reads value blocks and asks the developer.
   * @param _label What the secret unlocks, shown when it is asked.
   */
  constructor (private readonly _settings: EncryptionSettings, private readonly _context: BackendContext, private readonly _label: string) {}

  /**
   * Gives the key of each file, reading the secret on first use.
   * @returns The key of a file, from its salt.
   */
  async fileKey (): Promise<FileKey> {
    this._fileKey ??= this.read()
    return this._fileKey.catch((error: unknown) => {
      this._fileKey = null
      throw error
    })
  }

  /**
   * Forgets a password asked to the developer, so it is asked again.
   */
  forget (): void {
    if ('prompt' in this._settings) {
      this._fileKey = null
    }
  }

  /**
   * Reads the secret.
   * @returns The key of a file, from its salt.
   */
  private async read (): Promise<FileKey> {
    if ('key' in this._settings) {
      return keyFileKey(readEncryptionKey(await this._context.resolve(this._settings.key)))
    }
    if ('password' in this._settings) {
      return passwordFileKey(await this._context.resolve(this._settings.password))
    }
    return passwordFileKey(await this._context.askSecret(this._label))
  }
}

/**
 * Wraps a backend so the files are encrypted before they reach it and decrypted when they come back,
 * the progress of a transfer counting the bytes of content the encrypted bytes moved carry, as the
 * listed sizes and the local files do. A decrypted content
 * closed early closes the stored file, and the secret is forgotten only when it does not open a file.
 * @param backend The backend storing the encrypted files.
 * @param secret The secret of the files.
 * @returns The backend handling the encryption.
 */
export function encrypted (backend: EnvironmentBackend, secret: EncryptionSecret): EnvironmentBackend {
  return {
    boundsItself: backend.boundsItself,

    /**
     * Lists the stored files with their plain size.
     * @param signal Abandons the listing.
     * @returns The files, or null when the backend cannot list them.
     */
    async list (signal?: AbortSignal): Promise<RemoteFile[] | null> {
      const files = await backend.list(signal)
      return files?.map(file => ({ ...file, size: file.size === null ? null : plainLengthOf(file.size) ?? file.size })) ?? null
    },

    /**
     * Opens a stored file decrypted, its progress counted in bytes of content.
     * @param path The path of the file.
     * @param options Follows the bytes received, and abandons the download.
     * @returns Its content, or null when the file does not exist.
     */
    async download (path: string, options: TransferOptions = {}): Promise<Readable | null> {
      const fileKey = await secret.fileKey()
      const content = await backend.download(path, { ...options, onProgress: plainProgress(options.onProgress) })
      if (!content) {
        return null
      }
      const plain = streamPipeline(content, async function* (source: AsyncIterable<Buffer>) {
        yield* decrypt(source, fileKey, path)
      }, error => {
        if (error instanceof WrongSecretError) {
          secret.forget()
        }
      })
      plain.once('close', () => content.destroy())
      return plain
    },

    /**
     * Encrypts a local file and stores it, its progress counted in bytes of content.
     * @param path The path of the file in the backend.
     * @param localFile The local file.
     * @param _mediaType Unused, an encrypted file being stored as bytes.
     * @param options Follows the bytes sent.
     */
    async upload (path: string, localFile: string, _mediaType: string, options: TransferOptions = {}): Promise<void> {
      const fileKey = await secret.fileKey()
      const sealedFile = temporaryPathOf(localFile, 'sealed')
      try {
        await pipeline(Readable.from(encrypt(createReadStream(localFile), fileKey, path)), createWriteStream(sealedFile, { mode: 0o600 }))
        await backend.upload(path, sealedFile, 'application/octet-stream', { ...options, onProgress: plainProgress(options.onProgress) })
      } finally {
        await fs.rm(sealedFile, { force: true })
      }
    },

    async remove (path: string): Promise<void> {
      await backend.remove(path)
    },

    async close (): Promise<void> {
      await backend.close()
    },

    /**
     * Gets the secret of the files, asking the developer for it when it is typed, then what the
     * encrypted backend needs from the developer.
     */
    async prepare (): Promise<void> {
      await secret.fileKey()
      await backend.prepare?.()
    }
  }
}
