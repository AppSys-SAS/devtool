import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import http, { STATUS_CODES } from 'node:http'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+$/
const MAX_SEGMENTS = 16
const MAX_PATH_LENGTH = 512
const DEFAULT_MEDIA_TYPE = 'application/octet-stream'
const UNAVAILABLE_KEY_ERRORS = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID', 'ERR_JOSE_GENERIC'])

/**
 * @typedef {object} ServerConfig
 * @property {number} port Port to listen on, 0 for any free port.
 * @property {string} dataDir Folder storing the files.
 * @property {string} issuer Issuer of the access tokens.
 * @property {string} jwksUrl Address of the keys of the issuer.
 * @property {string} audience Audience the access tokens must carry.
 * @property {string | null} clientId Client the access tokens must be issued to, null to accept any.
 * @property {string[]} readGroups Groups allowed to list and download.
 * @property {string[]} writeGroups Groups allowed to list, download, upload and delete.
 * @property {number} maxBytes Largest file accepted, in bytes.
 */

/** An error answered to the client with its status. */
class HttpError extends Error {
  /**
   * @param {number} status The HTTP status.
   * @param {string} message The message shown to the client.
   */
  constructor (status, message) {
    super(message)
    this.status = status
  }
}

/**
 * Splits a comma separated list, blanks left out.
 * @param {string | undefined} value The list.
 * @returns {string[]} The items.
 */
function listOf (value) {
  return (value ?? '').split(',').map(item => item.trim()).filter(item => item !== '')
}

/**
 * Reads the configuration from environment variables.
 * @param {NodeJS.ProcessEnv} env The environment variables.
 * @returns {ServerConfig} The configuration.
 */
export function configFromEnv (env) {
  for (const name of ['ISSUER', 'JWKS_URL', 'AUDIENCE']) {
    if (!env[name]) {
      throw new Error(`${name} is required`)
    }
  }
  return {
    port: Number(env.PORT ?? 3100),
    dataDir: path.resolve(env.DATA_DIR ?? 'data'),
    issuer: env.ISSUER,
    jwksUrl: env.JWKS_URL,
    audience: env.AUDIENCE,
    clientId: env.CLIENT_ID || null,
    readGroups: listOf(env.READ_GROUPS ?? 'readers'),
    writeGroups: listOf(env.WRITE_GROUPS ?? 'writers'),
    maxBytes: Number(env.MAX_BYTES ?? 1024 * 1024 * 1024)
  }
}

/**
 * Sends a JSON answer.
 * @param {http.ServerResponse} res The response.
 * @param {number} status The HTTP status.
 * @param {unknown} body The body.
 */
function sendJson (res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' })
  res.end(text)
}

/**
 * Sends an error as JSON.
 * @param {http.ServerResponse} res The response.
 * @param {number} status The HTTP status.
 * @param {string} message The message.
 */
function sendError (res, status, message) {
  sendJson(res, status, { statusCode: status, message, error: STATUS_CODES[status] ?? 'Error' })
}

/**
 * Reads the path of a file from the address, each segment checked.
 * @param {string} encoded The part of the address after `/devtool/`.
 * @returns {string[]} The segments.
 */
function segmentsOf (encoded) {
  let segments
  try {
    segments = encoded.split('/').map(segment => decodeURIComponent(segment))
  } catch {
    throw new HttpError(404, 'no such file')
  }
  if (segments.length > MAX_SEGMENTS || segments.join('/').length > MAX_PATH_LENGTH || !segments.every(segment => SEGMENT.test(segment))) {
    throw new HttpError(404, 'no such file')
  }
  return segments
}

/**
 * Normalizes a media type, any invalid one becoming the generic binary type.
 * @param {string | undefined} header The Content-Type of the request.
 * @returns {string} The media type.
 */
function mediaTypeOf (header) {
  const type = (header ?? '').split(';')[0].trim().toLowerCase()
  return MEDIA_TYPE.test(type) ? type : DEFAULT_MEDIA_TYPE
}

/**
 * Creates the server of the devtool files API, not listening yet.
 * @param {ServerConfig} config The configuration.
 * @returns {http.Server} The server.
 */
export function createServer (config) {
  const keys = createRemoteJWKSet(new URL(config.jwksUrl), { timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 300_000 })
  const readers = new Set([...config.readGroups, ...config.writeGroups])
  const writers = new Set(config.writeGroups)
  const metaDir = path.join(config.dataDir, '.meta')
  const tmpDir = path.join(config.dataDir, '.tmp')

  /**
   * Checks the access token of a request and the groups it carries for the method.
   * @param {http.IncomingMessage} req The request.
   */
  async function authorize (req) {
    const [scheme, token] = (req.headers.authorization ?? '').split(' ')
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new HttpError(401, 'missing access token')
    }
    let payload
    try {
      ({ payload } = await jwtVerify(token, keys, { issuer: config.issuer, audience: config.audience, algorithms: ['RS256'], typ: 'at+jwt', clockTolerance: 30 }))
    } catch (error) {
      const code = error?.code
      if (code === undefined || UNAVAILABLE_KEY_ERRORS.has(code)) {
        throw new HttpError(503, 'token keys unavailable')
      }
      throw new HttpError(401, code === 'ERR_JWT_EXPIRED' ? 'expired token' : 'invalid access token')
    }
    if (config.clientId !== null && payload.client_id !== config.clientId) {
      throw new HttpError(401, 'access token of another client')
    }
    const groups = Array.isArray(payload.groups) ? payload.groups.filter(group => typeof group === 'string') : []
    const allowed = req.method === 'GET' || req.method === 'HEAD' ? readers : writers
    if (!groups.some(group => allowed.has(group))) {
      throw new HttpError(403, 'your groups do not allow this')
    }
  }

  /**
   * Lists the stored files, the folders of temporaries and media types left out.
   * @returns {Promise<{ path: string, size: number, updatedAt: string }[]>} The files.
   */
  async function listFiles () {
    const entries = await fs.readdir(config.dataDir, { recursive: true, withFileTypes: true }).catch(() => [])
    const files = []
    for (const entry of entries) {
      const relative = path.relative(config.dataDir, path.join(entry.parentPath, entry.name)).split(path.sep)
      if (!entry.isFile() || relative.some(segment => segment.startsWith('.'))) {
        continue
      }
      const stat = await fs.stat(path.join(entry.parentPath, entry.name))
      files.push({ path: relative.join('/'), size: stat.size, updatedAt: new Date(Math.floor(stat.mtimeMs)).toISOString() })
    }
    return files
  }

  /**
   * Sends a stored file, or only its headers for HEAD.
   * @param {http.IncomingMessage} req The request.
   * @param {http.ServerResponse} res The response.
   * @param {string[]} segments The path of the file.
   */
  async function download (req, res, segments) {
    const file = path.join(config.dataDir, ...segments)
    const stat = await fs.stat(file).catch(() => null)
    if (!stat?.isFile()) {
      throw new HttpError(404, 'no such file')
    }
    const type = await fs.readFile(path.join(metaDir, ...segments), 'utf8').catch(() => DEFAULT_MEDIA_TYPE)
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${segments.at(-1)}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    await pipeline(createReadStream(file), res)
  }

  /**
   * Stores the body of the request, replacing the file only once it arrived whole.
   * @param {http.IncomingMessage} req The request.
   * @param {http.ServerResponse} res The response.
   * @param {string[]} segments The path of the file.
   */
  async function upload (req, res, segments) {
    const announced = Number(req.headers['content-length'])
    if (Number.isFinite(announced) && announced > config.maxBytes) {
      res.on('finish', () => req.destroy())
      throw new HttpError(413, `the file weighs ${config.maxBytes} bytes at most`)
    }
    await fs.mkdir(tmpDir, { recursive: true })
    const temporary = path.join(tmpDir, randomUUID())
    let received = 0
    const counter = new Transform({
      transform (chunk, _encoding, callback) {
        received += chunk.length
        callback(received > config.maxBytes ? new HttpError(413, `the file weighs ${config.maxBytes} bytes at most`) : null, chunk)
      }
    })
    try {
      await pipeline(req, counter, createWriteStream(temporary, { mode: 0o600 }))
      if (received === 0) {
        throw new HttpError(400, 'the request carries no file')
      }
      const file = path.join(config.dataDir, ...segments)
      const previous = await fs.stat(file).then(stat => Math.floor(stat.mtimeMs), () => 0)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.mkdir(path.dirname(path.join(metaDir, ...segments)), { recursive: true })
      await fs.writeFile(path.join(metaDir, ...segments), mediaTypeOf(req.headers['content-type']))
      await fs.rename(temporary, file)
      const updatedAt = new Date(Math.max(Date.now(), previous + 1))
      await fs.utimes(file, updatedAt, updatedAt)
    } catch (error) {
      if (error?.code === 'ENOTDIR' || error?.code === 'EISDIR' || error?.code === 'EEXIST') {
        throw new HttpError(409, 'a file and a folder would share this path')
      }
      throw error
    } finally {
      await fs.rm(temporary, { force: true })
    }
    res.writeHead(204).end()
  }

  /**
   * Deletes a stored file; a missing file counts as deleted.
   * @param {http.ServerResponse} res The response.
   * @param {string[]} segments The path of the file.
   */
  async function remove (res, segments) {
    await fs.rm(path.join(config.dataDir, ...segments), { force: true }).catch(() => undefined)
    await fs.rm(path.join(metaDir, ...segments), { force: true }).catch(() => undefined)
    res.writeHead(204).end()
  }

  /**
   * Answers a request of the devtool files API.
   * @param {http.IncomingMessage} req The request.
   * @param {http.ServerResponse} res The response.
   */
  async function handle (req, res) {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost')
    if (pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok' })
      return
    }
    if (pathname !== '/devtool' && !pathname.startsWith('/devtool/')) {
      throw new HttpError(404, `Cannot ${req.method} ${pathname}`)
    }

    await authorize(req)
    const rest = pathname.slice('/devtool/'.length)
    if (rest === '') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, `Cannot ${req.method} ${pathname}`)
      }
      sendJson(res, 200, { files: await listFiles() })
      return
    }

    const segments = segmentsOf(rest)
    if (req.method === 'GET' || req.method === 'HEAD') {
      await download(req, res, segments)
    } else if (req.method === 'PUT') {
      await upload(req, res, segments)
    } else if (req.method === 'DELETE') {
      await remove(res, segments)
    } else {
      throw new HttpError(405, `Cannot ${req.method} ${pathname}`)
    }
  }

  return http.createServer((req, res) => {
    handle(req, res).catch(error => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendError(res, error instanceof HttpError ? error.status : 500, error instanceof HttpError ? error.message : 'Internal server error')
    })
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = configFromEnv(process.env)
  const server = createServer(config)
  server.listen(config.port, () => {
    process.stdout.write(`devtool files listening on port ${config.port}, storing in ${config.dataDir}\n`)
  })
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0))
  })
}
