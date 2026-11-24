import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { unzipSync } from 'fflate'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { zipFolder } from '../.vitepress/examples.js'
import { createServer } from '../examples/cdn-server/server.js'
import { CdnRequestError, createBackend, readBackends } from '../../packages/environment/src/backends/index.js'
import type { EnvironmentBackend } from '../../packages/environment/src/backends/index.js'

const ISSUER = 'https://auth.example.test'
const AUDIENCE = 'https://files.example.test'
const CLIENT_ID = 'devtool'
const CONFIG_FOLDER_VARIABLE = 'ADT_CONFIG_FOLDER'

let root: string
let jwks: http.Server
let server: http.Server
let url: string
let backend: EnvironmentBackend
let privateKey: CryptoKey
let previousFolder: string | undefined

/**
 * Starts a server on a free port of this machine.
 * @param target - The server.
 * @returns Its address.
 */
async function listen (target: http.Server): Promise<string> {
  await new Promise<void>(resolve => {
    target.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${(target.address() as AddressInfo).port}`
}

/**
 * Signs an access token of the test issuer for the given groups.
 * @param groups - The groups of the developer.
 * @returns The token.
 */
async function tokenFor (groups: string[]): Promise<string> {
  return new SignJWT({ groups, client_id: CLIENT_ID })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'test' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject('ada')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)
}

/**
 * Saves the session the devtool reads its access token from, as a sign-in does.
 * @param accessToken - The access token.
 */
async function signIn (accessToken: string): Promise<void> {
  const session = { issuer: ISSUER, clientId: CLIENT_ID, accessToken, expiresAt: Date.now() + 3_600_000, refreshToken: null }
  await fs.writeFile(path.join(root, 'config', 'session.json'), JSON.stringify(session))
}

/**
 * Writes a local file to upload.
 * @param name - The name of the file.
 * @param content - Its content.
 * @returns Its path.
 */
async function localFile (name: string, content: string | Buffer): Promise<string> {
  const file = path.join(root, 'local', name)
  await fs.writeFile(file, content)
  return file
}

/**
 * Reads a whole stream.
 * @param stream - The stream.
 * @returns Its bytes.
 */
async function readAll (stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * Tells the HTTP status a call of the backend failed with.
 * @param call - The call.
 * @returns The status of the CDN answer.
 */
async function statusOf (call: Promise<unknown>): Promise<number | null> {
  try {
    await call
    return null
  } catch (error) {
    expect(error).toBeInstanceOf(CdnRequestError)
    return (error as CdnRequestError).status
  }
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-cdn-server-'))
  await fs.mkdir(path.join(root, 'config'))
  await fs.mkdir(path.join(root, 'local'))
  previousFolder = process.env[CONFIG_FOLDER_VARIABLE]
  process.env[CONFIG_FOLDER_VARIABLE] = path.join(root, 'config')

  const keys = await generateKeyPair('RS256')
  privateKey = keys.privateKey
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'test', alg: 'RS256', use: 'sig' }
  jwks = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }))
  })
  const jwksUrl = `${await listen(jwks)}/jwks`

  server = createServer({
    port: 0,
    dataDir: path.join(root, 'data'),
    issuer: ISSUER,
    jwksUrl,
    audience: AUDIENCE,
    clientId: CLIENT_ID,
    readGroups: ['readers'],
    writeGroups: ['writers'],
    maxBytes: 1024
  })
  url = await listen(server)

  const { backends } = readBackends({ team: { type: 'cdn', url } })
  backend = createBackend(backends[0], {
    resolve: async text => Promise.resolve(text),
    askSecret: async () => Promise.reject(new Error('no secret in the tests')),
    cacheDir: path.join(root, 'cache'),
    configFolder: path.join(root, 'config'),
    auth: { type: 'openid', name: null, issuer: ISSUER, clientId: CLIENT_ID, callbackPort: 6732, scopes: ['openid'] }
  })
})

afterEach(async () => {
  await signIn(await tokenFor(['writers']))
})

afterAll(async () => {
  await backend.close()
  for (const target of [server, jwks]) {
    await new Promise(resolve => {
      target.close(resolve)
    })
  }
  if (previousFolder === undefined) {
    delete process.env[CONFIG_FOLDER_VARIABLE]
  } else {
    process.env[CONFIG_FOLDER_VARIABLE] = previousFolder
  }
  await fs.rm(root, { recursive: true, force: true })
})

describe('the example CDN server, through the cdn backend of the devtool', () => {
  it('stores a file, lists it, and gives it back as uploaded', async () => {
    await signIn(await tokenFor(['writers']))
    await backend.upload('api/config.yml', await localFile('config.yml', 'port: 3000\n'), 'application/yaml')

    const [listed] = (await backend.list())!.filter(file => file.path === 'api/config.yml')
    expect(listed).toMatchObject({ path: 'api/config.yml', size: 11 })
    expect(listed.updatedAt).toBeInstanceOf(Date)
    expect((await readAll((await backend.download('api/config.yml'))!)).toString()).toBe('port: 3000\n')

    await backend.upload('api/config.yml', await localFile('config.yml', 'port: 4000\n'), 'application/yaml')
    const [updated] = (await backend.list())!.filter(file => file.path === 'api/config.yml')
    expect(updated.version).not.toBe(listed.version)
  })

  it('serves the media type and the exact length of a file', async () => {
    await signIn(await tokenFor(['writers']))
    await backend.upload('web/db.gz', await localFile('db.gz', Buffer.from([1, 2, 3])), 'application/gzip; charset=binary')
    const response = await fetch(`${url}/devtool/web/db.gz`, { method: 'HEAD', headers: { Authorization: `Bearer ${await tokenFor(['readers'])}` } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/gzip')
    expect(response.headers.get('content-length')).toBe('3')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('gives nothing for an absent file, and deletes a file even twice', async () => {
    await signIn(await tokenFor(['writers']))
    expect(await backend.download('nothing/here.txt')).toBeNull()
    await backend.upload('tmp/note.txt', await localFile('note.txt', 'note'), 'text/plain')
    await backend.remove('tmp/note.txt')
    await backend.remove('tmp/note.txt')
    expect(await backend.download('tmp/note.txt')).toBeNull()
    expect((await backend.list())!.map(file => file.path)).not.toContain('tmp/note.txt')
  })

  it('lets readers download but not upload', async () => {
    await signIn(await tokenFor(['writers']))
    await backend.upload('shared.txt', await localFile('shared.txt', 'shared'), 'text/plain')
    await signIn(await tokenFor(['readers']))
    expect((await readAll((await backend.download('shared.txt'))!)).toString()).toBe('shared')
    expect(await statusOf(backend.upload('shared.txt', await localFile('other.txt', 'other'), 'text/plain'))).toBe(403)
    await signIn(await tokenFor(['visitors']))
    expect(await statusOf(backend.list())).toBe(403)
  })

  it('refuses an invalid token', async () => {
    await signIn('not-a-token')
    expect(await statusOf(backend.list())).toBe(401)
  })

  it('refuses invalid paths, empty and oversized files', async () => {
    await signIn(await tokenFor(['writers']))
    expect(await statusOf(backend.upload('.hidden', await localFile('hidden', 'x'), 'text/plain'))).toBe(404)
    expect(await backend.download('bad name.txt')).toBeNull()
    expect(await statusOf(backend.upload('empty.txt', await localFile('empty.txt', ''), 'text/plain'))).toBe(400)
    expect(await statusOf(backend.upload('large.bin', await localFile('large.bin', Buffer.alloc(2048)), 'application/octet-stream'))).toBe(413)
  })

  it('answers its health check without a token', async () => {
    expect(await (await fetch(`${url}/health`)).json()).toEqual({ status: 'ok' })
  })
})

describe('zipFolder', () => {
  it('packs an example under a folder of its name', async () => {
    const files = unzipSync(await zipFolder(path.join(import.meta.dirname, '../examples/cdn-server')))
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['cdn-server/server.js', 'cdn-server/README.md', 'cdn-server/Dockerfile', 'cdn-server/package.json']))
    expect(new TextDecoder().decode(files['cdn-server/package.json'])).toContain('"jose"')
  })
})
