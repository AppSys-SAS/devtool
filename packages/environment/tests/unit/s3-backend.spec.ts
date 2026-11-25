import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { BackendContext, BackendSettings, EnvironmentBackend, RemoteFile } from '../../src/backends/backend.js'
import { s3 } from '../../src/backends/s3.js'

const BUCKET = 'acme-dev'
const PAGE_SIZE = 2

interface StoredObject {
  body: Buffer
  contentType: string
  etag: string
  updatedAt: Date
}

const objects = new Map<string, StoredObject>()
const requests: string[] = []
let server: Server
let endpoint: string
let local: string

/**
 * Escapes a text for XML.
 * @param text - The text.
 * @returns The escaped text.
 */
function xml (text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Reads the body of a request, decoding the aws-chunked encoding the SDK uses for streamed uploads.
 * @param request - The request.
 * @returns The content sent.
 */
async function bodyOf (request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks)
  if (!String(request.headers['content-encoding'] ?? '').includes('aws-chunked') && request.headers['x-amz-decoded-content-length'] === undefined) {
    return raw
  }
  const parts: Buffer[] = []
  let offset = 0
  for (;;) {
    const lineEnd = raw.indexOf('\r\n', offset)
    const size = Number.parseInt(raw.subarray(offset, lineEnd).toString().split(';')[0], 16)
    if (size === 0) {
      return Buffer.concat(parts)
    }
    parts.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size))
    offset = lineEnd + 2 + size + 2
  }
}

/**
 * Answers the S3 requests of the tests: ListObjectsV2, GetObject, HeadObject, PutObject and DeleteObject, in path style.
 * @param request - The request.
 * @param response - The response.
 */
async function answer (request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const [, bucket, ...keyParts] = url.pathname.split('/')
  const key = keyParts.map(decodeURIComponent).join('/')
  requests.push(`${request.method} ${key}`)
  if (bucket !== BUCKET) {
    response.writeHead(404, { 'Content-Type': 'application/xml' }).end('<Error><Code>NoSuchBucket</Code></Error>')
    return
  }
  if (request.method === 'GET' && key === '' && url.searchParams.get('list-type') === '2') {
    const prefix = url.searchParams.get('prefix') ?? ''
    const keys = [...objects.keys()].filter(candidate => candidate.startsWith(prefix)).sort()
    const start = Number(url.searchParams.get('continuation-token') ?? '0')
    const page = keys.slice(start, start + PAGE_SIZE)
    const truncated = start + PAGE_SIZE < keys.length
    const contents = page.map(name => {
      const object = objects.get(name)!
      return `<Contents><Key>${xml(name)}</Key><LastModified>${object.updatedAt.toISOString()}</LastModified><ETag>"${object.etag}"</ETag><Size>${object.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`
    }).join('')
    const next = truncated ? `<NextContinuationToken>${start + PAGE_SIZE}</NextContinuationToken>` : ''
    response.writeHead(200, { 'Content-Type': 'application/xml' }).end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${BUCKET}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${PAGE_SIZE}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${next}${contents}</ListBucketResult>`)
    return
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    const object = objects.get(key)
    if (!object) {
      response.writeHead(404, { 'Content-Type': 'application/xml' }).end(request.method === 'GET' ? '<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>' : undefined)
      return
    }
    response.writeHead(200, { 'Content-Type': object.contentType, 'Content-Length': object.body.length, 'ETag': `"${object.etag}"`, 'Last-Modified': object.updatedAt.toUTCString() })
    response.end(request.method === 'GET' ? object.body : undefined)
    return
  }
  if (request.method === 'PUT') {
    const body = await bodyOf(request)
    const etag = createHash('md5').update(body).digest('hex')
    objects.set(key, { body, contentType: String(request.headers['content-type'] ?? 'application/octet-stream'), etag, updatedAt: new Date() })
    response.writeHead(200, { ETag: `"${etag}"` }).end()
    return
  }
  if (request.method === 'DELETE') {
    objects.delete(key)
    response.writeHead(204).end()
    return
  }
  response.writeHead(400).end()
}

/**
 * Lists the files of a backend that can list them.
 * @param backend - The backend.
 * @returns Its files.
 */
async function filesOf (backend: EnvironmentBackend): Promise<RemoteFile[]> {
  const files = await backend.list()
  if (files === null) {
    throw new Error('the backend cannot list its files')
  }
  return files
}

/**
 * Reads a whole stream.
 * @param stream - The stream.
 * @returns Its content as text.
 */
async function textOf (stream: Readable | null): Promise<string | null> {
  if (stream === null) {
    return null
  }
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Writes a local file to upload.
 * @param name - The name of the file.
 * @param content - Its content.
 * @returns Its path.
 */
async function localFile (name: string, content: string): Promise<string> {
  const file = path.join(local, name)
  await fs.writeFile(file, content)
  return file
}

/**
 * Creates an S3 backend on the fake service of the tests.
 * @param section - Settings merged over the bucket, the endpoint and the credentials.
 * @returns The backend.
 */
function backendOf (section: Record<string, unknown> = {}): EnvironmentBackend {
  const shared: BackendSettings = { type: 's3', slug: 'archive', default: false, encryption: null, groups: { pull: null, push: null } }
  const { options, problems } = s3.readOptions({
    bucket: BUCKET,
    endpoint,
    region: 'eu-west-1',
    pathStyle: true,
    accessKeyId: '{{ op://dev/s3/key }}',
    secretAccessKey: '{{ op://dev/s3/secret }}',
    ...section
  }, shared, 'environment.backends.archive')
  expect(problems).toEqual([])
  const context: BackendContext = {
    resolve: async text => text.replace('{{ op://dev/s3/key }}', 'key-id').replace('{{ op://dev/s3/secret }}', 'secret-key'),
    askSecret: async () => '',
    cacheDir: local,
    configFolder: local,
    auth: null
  }
  return s3.create(options!, context)
}

beforeAll(async () => {
  server = createServer((request, response) => {
    answer(request, response).catch(() => response.writeHead(500).end())
  })
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => {
    server.close(() => resolve())
  })
})

beforeEach(async () => {
  objects.clear()
  requests.length = 0
  local = await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-s3-'))
})

describe('s3 backend', () => {
  it('stores, lists under its prefix across pages, reads and deletes objects', async () => {
    const backend = backendOf({ prefix: 'environment' })
    objects.set('other/file.txt', { body: Buffer.from('not mine'), contentType: 'text/plain', etag: 'x', updatedAt: new Date() })
    objects.set('environment/folder/', { body: Buffer.alloc(0), contentType: 'application/x-directory', etag: 'd', updatedAt: new Date() })
    await backend.upload('api/config.yml', await localFile('config.yml', 'port: 3000\n'), 'application/yaml')
    await backend.upload('api/db.gz', await localFile('db.gz', 'archive'), 'application/gzip')
    await backend.upload('devtool/config.yml', await localFile('devtool.yml', 'adt: {}\n'), 'application/yaml')

    expect(objects.get('environment/api/config.yml')).toMatchObject({ contentType: 'application/yaml' })
    expect(objects.get('environment/api/config.yml')?.body.toString()).toBe('port: 3000\n')
    const files = await filesOf(backend)
    expect(files.map(file => file.path)).toEqual(['api/config.yml', 'api/db.gz', 'devtool/config.yml'])
    expect(files[0]).toMatchObject({ size: 11, version: createHash('md5').update('port: 3000\n').digest('hex') })
    expect(files[0].updatedAt).toBeInstanceOf(Date)
    expect(await textOf(await backend.download('api/db.gz'))).toBe('archive')

    await backend.remove('api/db.gz')
    expect(await backend.download('api/db.gz')).toBeNull()
    expect((await filesOf(backend)).map(file => file.path)).toEqual(['api/config.yml', 'devtool/config.yml'])
    await backend.close()
  })

  it('changes the version of a replaced object', async () => {
    const backend = backendOf()
    await backend.upload('api/config.yml', await localFile('a.yml', 'port: 3000\n'), 'application/yaml')
    const before = (await filesOf(backend))[0].version
    await backend.upload('api/config.yml', await localFile('b.yml', 'port: 4000\n'), 'application/yaml')
    expect((await filesOf(backend))[0].version).not.toBe(before)
    expect(await textOf(await backend.download('api/config.yml'))).toBe('port: 4000\n')
    await backend.close()
  })

  it('stores at the root of the bucket without prefix', async () => {
    const backend = backendOf()
    await backend.upload('notes.txt', await localFile('notes.txt', 'hello'), 'text/plain')
    expect([...objects.keys()]).toEqual(['notes.txt'])
    expect(await backend.download('missing.txt')).toBeNull()
    await backend.close()
  })
})
