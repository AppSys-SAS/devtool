import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { PassThrough, pipeline, type Readable } from 'node:stream'
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3'
import { type BackendContext, type BackendProblem, type BackendSettings, type BackendType, byteCounter, type EnvironmentBackend, readText, type RemoteFile, type TransferOptions } from './backend.js'

/** Settings of an S3 bucket storing the files, under a prefix. */
export interface S3Settings extends BackendSettings {
  type: 's3'
  bucket: string
  /** Prefix of the keys, empty or ending with `/`. */
  prefix: string
  /** Address of an S3 compatible service, null for AWS. */
  endpoint: string | null
  region: string
  /** Credentials, value blocks not read yet; null to use the default AWS credentials of the machine. */
  accessKeyId: string | null
  secretAccessKey: string | null
  /** Addresses the bucket in the path rather than in the host name. */
  pathStyle: boolean
}

/**
 * Files of the environment in an S3 bucket, under a prefix.
 */
class S3Backend implements EnvironmentBackend {
  private _client: Promise<S3Client> | null = null

  /**
   * @param _settings The bucket, its service and its credentials.
   * @param _context What the devtool provides, to read the value blocks of the credentials.
   */
  constructor (private readonly _settings: S3Settings, private readonly _context: BackendContext) {}

  /**
   * Lists the objects under the prefix, folders left out.
   * @returns The files, their version being the ETag of the object.
   */
  async list (): Promise<RemoteFile[]> {
    const client = await this.client()
    const files: RemoteFile[] = []
    let token: string | undefined
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: this._settings.bucket, Prefix: this._settings.prefix || undefined, ContinuationToken: token }))
      for (const object of page.Contents ?? []) {
        if (object.Key === undefined || object.Key.endsWith('/')) {
          continue
        }
        files.push({
          path: object.Key.slice(this._settings.prefix.length),
          size: object.Size ?? 0,
          updatedAt: object.LastModified ?? new Date(0),
          version: (object.ETag ?? '').replaceAll('"', '')
        })
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token !== undefined)
    return files
  }

  /**
   * Opens an object; the stream fails when the object arrives incomplete.
   * @param path The path of the file.
   * @param options Follows the bytes received, and abandons the request.
   * @returns Its content, or null when the object does not exist.
   */
  async download (path: string, { onProgress, signal }: TransferOptions = {}): Promise<Readable | null> {
    const client = await this.client()
    try {
      const object = await client.send(new GetObjectCommand({ Bucket: this._settings.bucket, Key: this._settings.prefix + path }), { abortSignal: signal })
      return pipeline(object.Body as Readable, byteCounter(object.ContentLength ?? null, onProgress), () => undefined)
    } catch (error) {
      if (error instanceof S3ServiceException && (error.name === 'NoSuchKey' || error.$metadata.httpStatusCode === 404)) {
        return null
      }
      throw error
    }
  }

  /**
   * Stores a local file as an object, streamed, replacing the stored one; a file that cannot be read
   * whole aborts the request.
   * @param path The path of the file.
   * @param localFile The local file.
   * @param mediaType The media type of the object.
   * @param options Follows the bytes sent.
   */
  async upload (path: string, localFile: string, mediaType: string, { onProgress }: TransferOptions = {}): Promise<void> {
    const client = await this.client()
    const { size } = await fs.stat(localFile)
    const abort = new AbortController()
    const body = pipeline(createReadStream(localFile), byteCounter(size, onProgress), error => {
      if (error) {
        abort.abort(error)
      }
    }).pipe(new PassThrough())
    try {
      await client.send(new PutObjectCommand({
        Bucket: this._settings.bucket,
        Key: this._settings.prefix + path,
        Body: body,
        ContentLength: size,
        ContentType: mediaType
      }), { abortSignal: abort.signal })
    } catch (error) {
      throw abort.signal.aborted ? abort.signal.reason : error
    }
  }

  /**
   * Deletes an object; a missing object counts as deleted.
   * @param path The path of the file.
   */
  async remove (path: string): Promise<void> {
    const client = await this.client()
    await client.send(new DeleteObjectCommand({ Bucket: this._settings.bucket, Key: this._settings.prefix + path }))
  }

  /**
   * Releases the connections of the client.
   */
  async close (): Promise<void> {
    const client = this._client
    this._client = null
    if (client !== null) {
      (await client.catch(() => null))?.destroy()
    }
  }

  /**
   * Gives the client of the service, its credentials read on first use.
   * @returns The client.
   */
  private async client (): Promise<S3Client> {
    this._client ??= this.connect().catch((error: unknown) => {
      this._client = null
      throw error
    })
    return this._client
  }

  /**
   * Creates the client of the service, reading the value blocks of the credentials.
   * @returns The client.
   */
  private async connect (): Promise<S3Client> {
    const { endpoint, region, pathStyle, accessKeyId, secretAccessKey } = this._settings
    const credentials = accessKeyId !== null && secretAccessKey !== null
      ? { accessKeyId: await this._context.resolve(accessKeyId), secretAccessKey: await this._context.resolve(secretAccessKey) }
      : undefined
    return new S3Client({ endpoint: endpoint ?? undefined, region, forcePathStyle: pathStyle, credentials })
  }
}

/** An S3 bucket, on AWS or on any S3 compatible service. */
export const s3: BackendType<S3Settings> = {
  type: 's3',

  readOptions (section, shared, setting) {
    const problems: BackendProblem[] = []
    const bucket = readText(section.bucket)
    if (bucket === null) {
      problems.push({ setting: `${setting}.bucket`, message: 'must name the bucket' })
    }
    const accessKeyId = readText(section.accessKeyId)
    const secretAccessKey = readText(section.secretAccessKey)
    if ((accessKeyId === null) !== (secretAccessKey === null)) {
      problems.push({ setting: `${setting}.accessKeyId`, message: 'needs secretAccessKey, and the reverse' })
    }
    if (section.pathStyle !== undefined && typeof section.pathStyle !== 'boolean') {
      problems.push({ setting: `${setting}.pathStyle`, message: 'must be true or false' })
    }
    if (bucket === null) {
      return { options: null, problems }
    }
    const prefix = readText(section.prefix)?.replace(/^\/+/, '') ?? ''
    return {
      options: {
        ...shared,
        type: 's3',
        bucket,
        prefix: prefix === '' || prefix.endsWith('/') ? prefix : `${prefix}/`,
        endpoint: readText(section.endpoint),
        region: readText(section.region) ?? 'us-east-1',
        accessKeyId: accessKeyId !== null && secretAccessKey !== null ? accessKeyId : null,
        secretAccessKey: accessKeyId !== null && secretAccessKey !== null ? secretAccessKey : null,
        pathStyle: section.pathStyle === true
      },
      problems
    }
  },

  create (options, context) {
    return new S3Backend(options, context)
  }
}
