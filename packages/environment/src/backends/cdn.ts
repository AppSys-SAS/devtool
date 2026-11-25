import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { pipeline, Readable, Transform, type TransformCallback } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { accessToken, type AuthOptions } from '@appsys-sas/devtool-auth'
import { type BackendSettings, type BackendType, type EnvironmentBackend, readText, type RemoteFile } from './backend.js'

/** Settings of a CDN serving the devtool files API under `<url>/devtool`. */
export interface CdnSettings extends BackendSettings {
  type: 'cdn'
  /** Base address of the CDN, without trailing slash. */
  url: string
}

/** Raised when the CDN answers with an error. */
export class CdnRequestError extends Error {
  /**
   * @param status The HTTP status of the answer.
   * @param message The message of the answer.
   */
  constructor (readonly status: number, message: string) {
    super(message)
    this.name = 'CdnRequestError'
  }
}

/**
 * Builds a stream failing at its end when it did not carry an exact length.
 * @param expected The expected length in bytes, or null to accept any.
 * @returns The transform checking the length.
 */
function lengthCheck (expected: number | null): Transform {
  let received = 0
  return new Transform({
    transform (chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      received += chunk.length
      callback(null, chunk)
    },
    flush (callback: TransformCallback): void {
      callback(expected !== null && received !== expected ? new Error(`incomplete download: ${received} of ${expected} bytes`) : null)
    }
  })
}

/**
 * Files of the devtool on a CDN, read and written with the access token of the signed-in developer.
 */
class CdnBackend implements EnvironmentBackend {
  /**
   * @param _url Base address of the CDN.
   * @param _auth The identity provider whose access token the CDN accepts, null when none is configured.
   */
  constructor (private readonly _url: string, private readonly _auth: AuthOptions | null) {}

  /**
   * Lists the stored files, with their size and their last upload.
   * @returns The files, or null when the CDN cannot list them.
   */
  async list (): Promise<RemoteFile[] | null> {
    const response = await this.request('GET', '')
    if (response.status === 404) {
      await response.body?.cancel()
      return null
    }
    await this.assertOk(response)
    const { files } = (await response.json()) as { files: { path: string, size: number, updatedAt: string }[] }
    return files.map(file => ({ path: file.path, size: file.size, updatedAt: new Date(file.updatedAt), version: new Date(file.updatedAt).toISOString() }))
  }

  /**
   * Opens a file; the stream fails when the file arrives incomplete.
   * @param path The path of the file.
   * @returns The content, or null when the file does not exist.
   */
  async download (path: string): Promise<Readable | null> {
    const response = await this.request('GET', path)
    if (response.status === 404) {
      await response.body?.cancel()
      return null
    }
    await this.assertOk(response)
    const length = response.headers.get('content-length')
    return pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), lengthCheck(length === null ? null : Number(length)), () => undefined)
  }

  /**
   * Uploads a local file, streamed, replacing the stored one.
   * @param path The path of the file on the CDN.
   * @param localFile The local file.
   * @param mediaType The media type served with the file.
   */
  async upload (path: string, localFile: string, mediaType: string): Promise<void> {
    const { size } = await fs.stat(localFile)
    await this.assertOk(await this.request('PUT', path, {
      headers: { 'Content-Type': mediaType, 'Content-Length': String(size) },
      body: Readable.toWeb(createReadStream(localFile)) as ReadableStream<Uint8Array>,
      duplex: 'half'
    }))
  }

  /**
   * Deletes a file; a missing file counts as deleted.
   * @param path The path of the file.
   */
  async remove (path: string): Promise<void> {
    await this.assertOk(await this.request('DELETE', path))
  }

  /**
   * Keeps no connection open.
   */
  async close (): Promise<void> {
    await Promise.resolve()
  }

  /**
   * Calls the devtool files of the CDN with the access token of the developer.
   * @param method The HTTP method.
   * @param path The path of the file, empty for the list of the files.
   * @param init The other request options.
   * @returns The answer.
   */
  private async request (method: string, path: string, init: RequestInit & { duplex?: 'half' } = {}): Promise<Response> {
    if (this._auth === null) {
      throw new Error('a cdn backend needs an auth section, signing the developers in')
    }
    const token = await accessToken(this._auth)
    const url = path === '' ? `${this._url}/devtool` : `${this._url}/devtool/${path.split('/').map(encodeURIComponent).join('/')}`
    return fetch(url, { ...init, method, headers: { ...init.headers, Authorization: `Bearer ${token}` } })
  }

  /**
   * Turns an error answer into an exception.
   * @param response The answer.
   */
  private async assertOk (response: Response): Promise<void> {
    if (response.ok) {
      return
    }
    const body = (await response.json().catch(() => null)) as { message?: unknown } | null
    const message = typeof body?.message === 'string' ? body.message : response.statusText
    throw new CdnRequestError(response.status, `CDN ${response.status}: ${message}`)
  }
}

/** A CDN serving the devtool files API, reached with the access token of the `auth` section. */
export const cdn: BackendType<CdnSettings> = {
  type: 'cdn',

  readOptions (section, shared, setting) {
    const url = readText(section.url)
    if (url === null || !/^https?:\/\//.test(url)) {
      return { options: null, problems: [{ setting: `${setting}.url`, message: 'must be the http or https address of the CDN' }] }
    }
    return { options: { ...shared, type: 'cdn', url: url.replace(/\/+$/, '') }, problems: [] }
  },

  create (options, context) {
    return new CdnBackend(options.url, context.auth)
  }
}
