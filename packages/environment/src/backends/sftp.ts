import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import SftpClient from 'ssh2-sftp-client'
import { type BackendContext, type BackendProblem, type BackendSettings, type BackendType, type EnvironmentBackend, readText, type RemoteFile } from './backend.js'

const PARTIAL_SUFFIX = '.part'

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
   * Opens a file of the folder.
   * @param filePath The path of the file.
   * @returns Its content, or null when the file does not exist.
   */
  async download (filePath: string): Promise<Readable | null> {
    const client = await this.client()
    const remotePath = this.remotePath(filePath)
    if (await client.exists(remotePath) !== '-') {
      return null
    }
    const content = client.createReadStream(remotePath)
    this._downloads.add(content)
    content.once('close', () => this._downloads.delete(content))
    return content
  }

  /**
   * Stores a local file, written next to its place then renamed, so a cut upload never replaces the stored file.
   * @param filePath The path of the file.
   * @param localFile The local file.
   */
  async upload (filePath: string, localFile: string): Promise<void> {
    const client = await this.client()
    const remotePath = this.remotePath(filePath)
    const partialPath = `${remotePath}${PARTIAL_SUFFIX}`
    await client.mkdir(path.posix.dirname(remotePath), true)
    await client.put(localFile, partialPath)
    try {
      await client.posixRename(partialPath, remotePath)
    } catch {
      await client.delete(remotePath, true)
      await client.rename(partialPath, remotePath)
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
   * Gives the connection to the server, opened on first use and after it dropped.
   * @returns The connected client.
   */
  private async client (): Promise<SftpClient> {
    this._client ??= this.connect().catch((error: unknown) => {
      this._client = null
      throw error
    })
    return this._client
  }

  /**
   * Opens the connection, signing in with the private key, else the password, else the SSH agent.
   * @returns The connected client.
   */
  private async connect (): Promise<SftpClient> {
    const { host, port, username, privateKey, passphrase, password } = this._settings
    const forget = (): void => {
      this._client = null
    }
    const client = new SftpClient('devtool', { error: forget, end: forget, close: forget })
    const auth: SftpClient.ConnectOptions = {}
    if (privateKey !== null) {
      auth.privateKey = await fs.readFile(privateKey.startsWith('~/') ? path.join(os.homedir(), privateKey.slice(2)) : privateKey)
      if (passphrase !== null) {
        auth.passphrase = await this._context.resolve(passphrase)
      }
    } else if (password !== null) {
      auth.password = await this._context.resolve(password)
    } else if (process.env.SSH_AUTH_SOCK) {
      auth.agent = process.env.SSH_AUTH_SOCK
    } else {
      throw new Error(`cannot sign in to ${host}: set privateKey or password on the sftp backend, or start an SSH agent`)
    }
    await client.connect({ host, port, username, ...auth })
    return client
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
