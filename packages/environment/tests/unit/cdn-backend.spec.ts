import fs from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pipeline, Readable } from 'node:stream'
import type { AuthOptions } from '@appsys-sas/devtool-auth'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { type BackendSettings, byteCounter, type EnvironmentBackend } from '../../src/backends/backend.js'
import { cdn } from '../../src/backends/cdn.js'
import { expectCompleteProgress, progressContent, progressRecorder } from './progress-fixtures.js'

const AUTH: AuthOptions = { type: 'openid', name: null, issuer: 'https://auth.example.dev', clientId: 'devtool', callbackPort: 0, scopes: [] }

const stored = new Map<string, Buffer>()
let server: Server
let url: string
let folder: string

/**
 * Reads a whole stream.
 * @param stream - The stream.
 * @returns Its bytes.
 */
async function bytesOf (stream: Readable | null): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream ?? []) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const key = decodeURIComponent(request.url ?? '')
      if (key.endsWith('never-answered.gz')) {
        return
      }
      if (request.method === 'PUT') {
        stored.set(key, Buffer.concat(chunks))
        response.writeHead(204).end()
        return
      }
      const body = stored.get(key)
      if (body === undefined) {
        response.writeHead(404, { 'Content-Type': 'application/json' }).end('{"message":"not found"}')
        return
      }
      response.writeHead(200, { 'Content-Length': String(body.length) }).end(body)
    })
  })
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => {
    server.close(() => resolve())
  })
})

beforeEach(async () => {
  stored.clear()
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-cdn-'))
  const session = { issuer: AUTH.issuer, clientId: AUTH.clientId, accessToken: 'token', expiresAt: Date.now() + 3_600_000, refreshToken: null, user: null }
  await fs.writeFile(path.join(folder, 'session.json'), JSON.stringify(session))
  vi.stubEnv('ADT_CONFIG_FOLDER', folder)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fs.rm(folder, { recursive: true, force: true })
})

/**
 * Creates a cdn backend on the server of the tests.
 * @returns The backend.
 */
function backendOf (): EnvironmentBackend {
  const shared: BackendSettings = { type: 'cdn', slug: 'team', default: true, encryption: null, groups: { pull: null, push: null } }
  const { options } = cdn.readOptions({ url }, shared, 'environment.backends.team')
  return cdn.create(options!, { resolve: async text => text, askSecret: async () => '', cacheDir: folder, configFolder: folder, auth: AUTH })
}

describe('cdn backend', () => {
  it('abandons a download its signal cancels before the server answers', async () => {
    const cancel = new AbortController()
    setTimeout(() => cancel.abort(new Error('cancelled')), 100)
    await expect(backendOf().download('api/never-answered.gz', { signal: cancel.signal })).rejects.toThrow('cancelled')
  }, 10_000)

  it('fails a download that arrives shorter than announced', async () => {
    await expect(bytesOf(pipeline(Readable.from([Buffer.alloc(10)]), byteCounter(20), () => undefined))).rejects.toThrow('incomplete transfer: 10 of 20 bytes')
  })

  it('reports the bytes it sends and receives, against the size of the file', async () => {
    const backend = backendOf()
    const content = progressContent()
    const localFile = path.join(folder, 'db.gz')
    await fs.writeFile(localFile, content)

    const sent = progressRecorder()
    await backend.upload('api/db.gz', localFile, 'application/gzip', { onProgress: sent.onProgress })
    expect(stored.get('/devtool/api/db.gz')?.equals(content)).toBe(true)
    expectCompleteProgress(sent.reports, content.length)

    const received = progressRecorder()
    expect((await bytesOf(await backend.download('api/db.gz', { onProgress: received.onProgress }))).equals(content)).toBe(true)
    expectCompleteProgress(received.reports, content.length)
  })
})
