import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline, type Readable } from 'node:stream'
import ssh2 from 'ssh2'
import SftpClient from 'ssh2-sftp-client'
import { BACKEND_IDLE_MS, type BackendContext, type BackendProblem, type BackendSettings, type BackendType, byteCounter, type EnvironmentBackend, PossiblyStoredError, readText, type RemoteFile, type TransferOptions, unlessAborted } from './backend.js'

const PARTIAL_SUFFIX = '.part'
const KEEPALIVE_TRIES = 4

/** A request whose answer never came, the connection having dropped: the server may have done it. */
class UnansweredError extends Error {}

/**
 * Waits for the answer of the server to a request, closing the connection when none comes within
 * the time a backend may show no activity, which fails the request.
 * @param client The connected client.
 * @param request The request.
 * @returns What the request gives.
 * @throws {UnansweredError} When the connection dropped before the answer came.
 */
async function answered<T> (client: SftpClient, request: Promise<T>): Promise<T> {
  let dropped = false
  /**
   * Notes that the connection dropped while the request waits.
   */
  const drop = (): void => {
    dropped = true
  }
  const events = ['error', 'end', 'close']
  for (const event of events) {
    client.on(event, drop)
  }
  const late = setTimeout(() => {
    dropped = true
    client.end().catch(() => undefined)
  }, BACKEND_IDLE_MS)
  try {
    return await request
  } catch (error) {
    throw dropped ? new UnansweredError(`the server did not answer: ${error instanceof Error ? error.message : String(error)}`, { cause: error }) : error
  } finally {
    clearTimeout(late)
    for (const event of events) {
      client.removeListener(event, drop)
    }
  }
}

/**
 * Removes the partial file of a failed upload.
 * @param client The connected client.
 * @param partialPath The partial file.
 * @param error Why the upload failed.
 * @returns The error to raise, telling also when the partial file could not be removed.
 */
async function withoutPartial (client: SftpClient, partialPath: string, error: unknown): Promise<Error> {
  const failure = await answered(client, client.delete(partialPath, true)).then(() => null, (cause: unknown) => cause)
  const reason = error instanceof Error ? error : new Error(String(error))
  return failure === null ? reason : new Error(`${reason.message}; the partial file ${partialPath} could not be removed`, { cause: error })
}

/** Settings of an SFTP server storing the files under a folder. */
export interface SftpSettings extends BackendSettings {
  type: 'sftp'
  host: string
  port: number
  username: string
  /** Folder of the files on the server. */
  path: string
  /** Private key file, `~/` allowed; null to use the password or the SSH agent. */
  privateKey: string | null
  /** Passphrase of the private key, value blocks not read yet. */
  passphrase: string | null
  /** Password, value blocks not read yet; null to use the key or the SSH agent. */
  password: string | null
}

/**
 * Files of the environment in a folder of an SFTP server, the connection opened on first use and
 * opened again when it drops.
 */
class SftpBackend implements EnvironmentBackend {
  private _client: Promise<SftpClient> | null = null
  private readonly _downloads = new Set<Readable>()
  private readonly _secrets = new Map<string, Promise<string>>()

  /**
   * @param _settings The server, its folder and how to sign in.
   * @param _context What the devtool provides, to read the value blocks of the secrets.
   */
  constructor (private readonly _settings: SftpSettings, private readonly _context: BackendContext) {}

  /**
   * Lists the files under the folder, recursively, unfinished uploads left out.
   * @returns The files, their version made of their modification time and size.
   */
  async list (): Promise<RemoteFile[]> {
    const client = await this.client()
    const files: RemoteFile[] = []
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await client.list(this.remotePath(folder))) {
        const relative = folder === '' ? entry.name : `${folder}/${entry.name}`
        if (entry.type === 'd') {
          await walk(relative)
        } else if (entry.type === '-' && !entry.name.endsWith(PARTIAL_SUFFIX)) {
          files.push({ path: relative, size: entry.size, updatedAt: new Date(entry.modifyTime), version: `${entry.modifyTime}-${entry.size}` })
        }
      }
    }
    if (await client.exists(this._settings.path)) {
      await walk('')
    }
    return files
  }

  /**
   * Opens a file of the folder; the stream fails when the file arrives incomplete.
   * @param filePath The path of the file.
   * @param options Follows the bytes received.
   * @returns Its content, or null when the file does not exist.
   */
  async download (filePath: string, { onProgress }: TransferOptions = {}): Promise<Readable | null> {
    const client = await this.client()
    const remotePath = this.remotePath(filePath)
    if (await client.exists(remotePath) !== '-') {
      return null
    }
    const { size } = await client.stat(remotePath)
    const content = client.createReadStream(remotePath)
    this._downloads.add(content)
    content.once('close', () => this._downloads.delete(content))
    return pipeline(content, byteCounter(size, onProgress), () => undefined)
  }

  /**
   * Stores a local file, written next to its place then renamed, so a cut upload never replaces the
   * stored file. A server without atomic rename gets the stored file moved aside, never deleted,
   * until the new one takes its place. A connection that drops while the server renames tells that
   * the stored file may have been replaced.
   * @param filePath The path of the file.
   * @param localFile The local file.
   * @param _mediaType Unused, a file of the server having no media type.
   * @param options Follows the bytes sent, and cancels the upload: at once while the file is written,
   * the partial file then removed, and between two renames that put it in place, the stored file
   * then put back, so a cancelled upload never replaces it.
   */
  async upload (filePath: string, localFile: string, _mediaType: string, { onProgress, signal }: TransferOptions = {}): Promise<void> {
    const client = await unlessAborted(this.client(), signal)
    const remotePath = this.remotePath(filePath)
    const partialPath = `${remotePath}.${randomUUID()}${PARTIAL_SUFFIX}`
    const { size } = await fs.stat(localFile)
    await unlessAborted(client.mkdir(path.posix.dirname(remotePath), true), signal)
    const source = createReadStream(localFile)
    /**
     * Stops reading the local file once the upload is cancelled.
     */
    const cancel = (): void => {
      source.destroy(new Error('upload cancelled'))
    }
    signal?.addEventListener('abort', cancel, { once: true })
    const written = client.put(pipeline(source, byteCounter(size, onProgress), () => undefined), partialPath)
    try {
      await unlessAborted(written, signal)
      signal?.throwIfAborted()
    } catch (error) {
      if (!signal?.aborted) {
        throw await withoutPartial(client, partialPath, error)
      }
      void this.dropPartial(client, partialPath)
      throw error
    } finally {
      signal?.removeEventListener('abort', cancel)
      source.destroy()
    }
    await answered(client, client.posixRename(partialPath, remotePath)).catch(async (error: unknown) => {
      if (error instanceof UnansweredError) {
        throw new PossiblyStoredError(`the stored file may have been replaced: ${error.message}`, { cause: error })
      }
      signal?.throwIfAborted()
      await this.replaceAside(client, partialPath, remotePath, signal)
    }).catch(async (error: unknown) => {
      throw error instanceof PossiblyStoredError ? error : await withoutPartial(client, partialPath, error)
    })
  }

  /**
   * Deletes the partial file of a cancelled upload without waiting for the server to end writing it,
   * the partial file being left under a name the listing leaves out when the server does not answer.
   * @param client The connected client.
   * @param partialPath The partial file.
   */
  private async dropPartial (client: SftpClient, partialPath: string): Promise<void> {
    await answered(client, client.delete(partialPath, true)).catch(() => undefined)
  }

  /**
   * Replaces a stored file by another one with plain renames: the stored file is moved aside under
   * a name the listing leaves out, put back when the new one cannot take its place or the upload is
   * cancelled meanwhile, and deleted once it did, or left aside when it cannot be deleted. A rename
   * whose answer never came tells where each file may be.
   * @param client The connected client.
   * @param partialPath The new file.
   * @param remotePath The stored file.
   * @param signal Cancels the replacement before the new file takes the place of the stored one.
   */
  private async replaceAside (client: SftpClient, partialPath: string, remotePath: string, signal?: AbortSignal): Promise<void> {
    const asidePath = `${remotePath}.${randomUUID()}${PARTIAL_SUFFIX}`
    const stored = await answered(client, client.exists(remotePath)) === '-'
    signal?.throwIfAborted()
    if (stored) {
      await answered(client, client.rename(remotePath, asidePath)).catch((error: unknown) => {
        throw error instanceof UnansweredError ? new Error(`${error.message}; the stored file may now be at ${asidePath}`, { cause: error }) : error
      })
    }
    try {
      signal?.throwIfAborted()
      await answered(client, client.rename(partialPath, remotePath))
    } catch (error) {
      if (error instanceof UnansweredError) {
        throw new PossiblyStoredError(`the stored file may have been replaced${stored ? `, the former one being at ${asidePath}` : ''}: ${error.message}`, { cause: error })
      }
      if (stored) {
        await answered(client, client.rename(asidePath, remotePath)).catch((failure: unknown) => {
          throw new Error(`${error instanceof Error ? error.message : String(error)}; the stored file stays at ${asidePath}: ${failure instanceof Error ? failure.message : String(failure)}`, { cause: error })
        })
      }
      throw error
    }
    if (stored) {
      await answered(client, client.delete(asidePath, true)).catch(() => undefined)
    }
  }

  /**
   * Deletes a file; a missing file counts as deleted.
   * @param filePath The path of the file.
   */
  async remove (filePath: string): Promise<void> {
    const client = await this.client()
    await client.delete(this.remotePath(filePath), true)
  }

  /**
   * Closes the connection when one is open, once the downloads still reading have released their file.
   */
  async close (): Promise<void> {
    await Promise.all([...this._downloads].map(async content => new Promise<void>(resolve => {
      content.once('close', () => resolve())
      if (!content.readableEnded) {
        content.destroy()
      }
    })))
    const client = this._client
    this._client = null
    const connected = await client?.catch(() => null)
    await connected?.end()
  }

  /**
   * Gives the path of a file on the server.
   * @param filePath The path of the file in the environment, empty for the folder itself.
   * @returns The path on the server.
   */
  private remotePath (filePath: string): string {
    return filePath === '' ? this._settings.path : path.posix.join(this._settings.path, filePath)
  }

  /**
   * Opens the connection, reading the secrets that sign in, which may ask the developer to approve their reading.
   */
  async prepare (): Promise<void> {
    await this.client()
  }

  /**
   * Gives the connection to the server, opened on first use and again once it failed or closed.
   * @returns The connected client.
   */
  private async client (): Promise<SftpClient> {
    if (this._client === null) {
      /**
       * Forgets the connection once it failed or closed, so the next use opens another one.
       */
      const forget = (): void => {
        if (this._client === connection) {
          this._client = null
        }
      }
      const connection: Promise<SftpClient> = this.connect(forget).catch((error: unknown) => {
        forget()
        throw error
      })
      this._client = connection
    }
    return this._client
  }

  /**
   * Opens the connection, signing in with the private key, else the password, else the SSH agent.
   * The connection closes, failing what waits on it, when it cannot be opened in time or the
   * server stops answering its keepalive messages.
   * @param forget Told once the connection failed or closed.
   * @returns The connected client.
   */
  private async connect (forget: () => void): Promise<SftpClient> {
    const { host, port, username, privateKey, passphrase, password } = this._settings
    const client = new SftpClient('devtool', { error: forget, end: forget, close: forget })
    for (const event of ['error', 'end', 'close']) {
      client.on(event, forget)
    }
    client.on('error', (error: { level?: string }) => {
      if (error.level === 'client-authentication' && privateKey === null && password !== null) {
        this._secrets.delete(password)
      }
    })
    const auth: SftpClient.ConnectOptions = {}
    if (privateKey !== null) {
      auth.privateKey = await fs.readFile(privateKey.startsWith('~/') ? path.join(os.homedir(), privateKey.slice(2)) : privateKey)
      if (passphrase !== null) {
        auth.passphrase = await this.secret(passphrase)
        const parsed = ssh2.utils.parseKey(auth.privateKey, auth.passphrase)
        if (parsed instanceof Error) {
          this._secrets.delete(passphrase)
          throw new Error(`cannot read the private key ${privateKey}: ${parsed.message}`)
        }
      }
    } else if (password !== null) {
      auth.password = await this.secret(password)
    } else if (process.env.SSH_AUTH_SOCK) {
      auth.agent = process.env.SSH_AUTH_SOCK
    } else {
      throw new Error(`cannot sign in to ${host}: set privateKey or password on the sftp backend, or start an SSH agent`)
    }
    await client.connect({ host, port, username, ...auth, readyTimeout: BACKEND_IDLE_MS, keepaliveInterval: BACKEND_IDLE_MS / KEEPALIVE_TRIES, keepaliveCountMax: KEEPALIVE_TRIES - 1 })
    return client
  }

  /**
   * Reads a secret that signs in, its value blocks read once, so that opening the connection again
   * never asks the developer again, unless the server refused them.
   * @param value The secret, value blocks not read yet.
   * @returns The secret.
   */
  private async secret (value: string): Promise<string> {
    let read = this._secrets.get(value)
    if (!read) {
      read = this._context.resolve(value)
      this._secrets.set(value, read)
      read.catch(() => this._secrets.delete(value))
    }
    return read
  }
}

/** An SFTP server, signed in to with a key, a password or the SSH agent of the developer. */
export const sftp: BackendType<SftpSettings> = {
  type: 'sftp',

  readOptions (section, shared, setting) {
    const problems: BackendProblem[] = []
    const host = readText(section.host)
    const username = readText(section.username)
    const port = section.port === undefined ? 22 : Number(section.port)
    if (host === null) {
      problems.push({ setting: `${setting}.host`, message: 'must name the SFTP server' })
    }
    if (username === null) {
      problems.push({ setting: `${setting}.username`, message: 'must name the user on the SFTP server' })
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      problems.push({ setting: `${setting}.port`, message: 'must be a port between 1 and 65535' })
    }
    if (host === null || username === null || problems.length > 0) {
      return { options: null, problems }
    }
    return {
      options: {
        ...shared,
        type: 'sftp',
        host,
        port,
        username,
        path: readText(section.path) ?? '.',
        privateKey: readText(section.privateKey),
        passphrase: readText(section.passphrase),
        password: readText(section.password)
      },
      problems
    }
  },

  create (options, context) {
    return new SftpBackend(options, context)
  }
}
