import http from 'node:http'
import type { Http2ServerRequest } from 'node:http2'
import https from 'node:https'
import { logger } from '@appsys/devtool-shared'
import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http'
import type { Socket } from 'node:net'
import type { HostAccess, RuntimeConfig } from '@appsys/devtool-shared'
import { allows, clientAddressOf } from './access.js'

const httpAgent = new http.Agent({ keepAlive: true })
const httpsAgent = new https.Agent({ keepAlive: true })

/** Headers describing a single connection, never forwarded from one connection to another. */
const CONNECTION_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'http2-settings', 'host'])

/** A request the load balancer receives, over HTTP/1.1 or HTTP/2. */
export type ProxyRequest = IncomingMessage | Http2ServerRequest

/** The response to a request the load balancer receives, over HTTP/1.1 or HTTP/2. */
export interface ProxyResponse extends NodeJS.WritableStream {
  readonly headersSent: boolean
  writeHead(statusCode: number, headers?: OutgoingHttpHeaders): unknown
}

/**
 * Gives the host name a request is sent to.
 * @param request The request.
 * @returns The host name, lower case, without port.
 */
export function requestHost (request: ProxyRequest): string {
  const authority = request.headers[':authority'] ?? request.headers.host ?? ''
  return String(authority).split(':')[0].toLowerCase()
}

/**
 * Copies the headers of a response, without those describing its connection, letting one host frame
 * it when given.
 * @param response The response.
 * @param frameAncestor The host allowed to show the response in a frame, null to keep the framing rules
 * of the response.
 * @returns The headers to send on.
 */
function responseHeaders (response: IncomingMessage, frameAncestor: string | null): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(response.headers)) {
    if (value !== undefined && !CONNECTION_HEADERS.has(name)) {
      headers[name] = value
    }
  }
  if (!frameAncestor) {
    return headers
  }

  delete headers['x-frame-options']
  const policies = [headers['content-security-policy'] ?? []].flat().flatMap(value => String(value).split(',')).map(policy =>
    policy
      .split(';')
      .map(directive => directive.trim())
      .filter(directive => directive && !/^frame-ancestors\b/i.test(directive))
      .join('; ')
  )
  headers['content-security-policy'] = [...policies.filter(Boolean), `frame-ancestors ${frameAncestor}:*`].join(', ')
  return headers
}

/**
 * Writes the status line and the headers of a response on a raw connection.
 * @param socket The connection.
 * @param response The response.
 */
function writeHead (socket: Socket, response: IncomingMessage): void {
  const lines = [`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? ''}`]
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`)
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
}

interface ServerCandidate {
  slug: string
  hosts: string[]
  targets: {
    url: string
    tls: boolean
  }[]
  path: string | null
  prefix: string | null
  pathNot: string | null
  preserveHost: boolean
  access: HostAccess
  roundRobinTargetIndex: number
}

function readUiProxyTarget (uiPath: string | undefined): { url: string, tls: boolean } | null {
  if (typeof uiPath !== 'string') {
    return null
  }

  const value = uiPath.trim()
  if (!value.length) {
    return null
  }

  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }

    return {
      url: parsed.toString(),
      tls: parsed.protocol === 'https:'
    }
  } catch {
    return null
  }
}

export class DevtoolProxy {
  private serversAvailable: ServerCandidate[]

  /** Hosts of the integrations shown in the devtool, which the devtool host may frame. */
  private framedHosts = new Set<string>()

  /** The host allowed to frame the integrations, null without a devtool host. */
  private frameAncestor: string | null = null

  constructor () {
    this.serversAvailable = []
  }

  /**
   * Builds the routes of the configuration: the services of the directories and the interface of the
   * devtool, each with who may reach it, and the hosts the devtool frames.
   * @param config The configuration.
   */
  reload (config: RuntimeConfig): void {
    const nextServers: ServerCandidate[] = []
    const integrations = [...config.integrations, ...Object.values(config.projects).flatMap(project => Object.values(project.directories).flatMap(directory => directory.integrations))]
    this.framedHosts = new Set(integrations.filter(integration => integration.embed).map(integration => new URL(integration.url).hostname.toLowerCase()))
    this.frameAncestor = config.adt.host?.toLowerCase() ?? null

    for (const [projectSlug, project] of Object.entries(config.projects)) {
      for (const [directorySlug, directory] of Object.entries(project.directories)) {
        for (const [serverSlug, server] of Object.entries(directory.loadBalancer)) {
          const targets = server.targets.map(url => ({ url, tls: server.tls || url.startsWith('https://') }))

          if (!targets.length) {
            continue
          }

          nextServers.push({
            slug: `${projectSlug}:${directorySlug}:${serverSlug}`,
            hosts: server.hosts.map(host => host.toLowerCase()),
            targets,
            path: server.path,
            prefix: server.prefix,
            pathNot: server.pathNot,
            preserveHost: server.preserveHost,
            access: server.access,
            roundRobinTargetIndex: targets.length - 1
          })
        }
      }
    }

    if (config.adt.host) {
      const uiProxyTarget = readUiProxyTarget(config.adt.uiPath)
      const targets = [uiProxyTarget ?? { url: `http://127.0.0.1:${config.adt.ports.server}`, tls: true }]
      nextServers.push({
        slug: 'DEVTOOL:HTTP',
        hosts: [config.adt.host.toLowerCase()],
        targets,
        path: null,
        prefix: null,
        pathNot: null,
        preserveHost: false,
        access: config.adt.access,
        roundRobinTargetIndex: targets.length - 1
      })
    }

    this.serversAvailable = nextServers
  }

  /**
   * Tells who reaches a host, whatever the path asked for.
   * @param host The host name, lower case.
   * @returns `network` when some server of the host is reachable from the network, `local` when none
   * is, null when no server serves the host.
   */
  accessOf (host: string): HostAccess | null {
    const servers = this.serversAvailable.filter(candidate => candidate.hosts.includes(host))
    if (!servers.length) {
      return null
    }
    return servers.some(server => server.access === 'network') ? 'network' : 'local'
  }

  /**
   * Proxies an HTTP/1.1 or HTTP/2 request to the server matching its host and path, reusing upstream
   * connections, answering 403 when the client may not reach that server and 503 when it is down.
   * @param req Incoming request.
   * @param res Response to write to.
   * @returns True when a server matched, the request being proxied or refused.
   */
  proxyRequest (req: ProxyRequest, res: ProxyResponse): boolean {
    const host = requestHost(req)
    const server = this.getMatchServer(host, req.url ?? '/')
    if (!server) {
      return false
    }

    const client = clientAddressOf(req.socket)
    if (!allows(server.access, client)) {
      logger.warn('Proxy', server.slug, `Refused for ${client}`)
      res.writeHead(403)
      res.end('403 Forbidden')
      return true
    }

    let completed = false
    const frameAncestor = this.framedHosts.has(host) ? this.frameAncestor : null
    const outgoing = this.openRequest(req, server, this.nextTarget(server), client, false)
    outgoing.on('response', response => {
      res.writeHead(response.statusCode ?? 502, responseHeaders(response, frameAncestor))
      response.on('end', () => (completed = true))
      response.pipe(res)
    })
    outgoing.on('error', error => {
      logger.warn('Proxy', server.slug, error.message)
      if (res.headersSent) {
        res.end()
        return
      }
      res.writeHead(503)
      res.end('503 Service Unavailable')
    })
    res.on('close', () => {
      if (!completed) {
        outgoing.destroy()
      }
    })
    req.pipe(outgoing)
    return true
  }

  /**
   * Proxies a WebSocket upgrade to the server matching its host and path, or closes the connection
   * when the client may not reach that server.
   * @param req Incoming upgrade request.
   * @param socket Connection of the client.
   * @param head First bytes of the upgraded stream.
   * @returns True when a server matched, the upgrade being proxied or refused.
   */
  proxyUpgrade (req: IncomingMessage, socket: Socket, head: Buffer): boolean {
    const server = this.getMatchServer(requestHost(req), req.url ?? '/')
    if (!server) {
      return false
    }

    const client = clientAddressOf(socket)
    if (!allows(server.access, client)) {
      logger.warn('Proxy', server.slug, `Refused for ${client}`)
      socket.destroy()
      return true
    }

    const outgoing = this.openRequest(req, server, this.nextTarget(server), client, true)
    outgoing.on('upgrade', (response, upstream, upstreamHead) => {
      writeHead(socket, response)
      socket.write(upstreamHead)
      upstream.write(head)
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
      upstream.pipe(socket).pipe(upstream)
    })
    outgoing.on('response', response => {
      writeHead(socket, response)
      response.pipe(socket)
    })
    outgoing.on('error', error => {
      logger.warn('Proxy', server.slug, error.message)
      socket.destroy()
    })
    outgoing.end()
    return true
  }

  /**
   * Opens the request to a target of a server, with the headers of the incoming request but those
   * describing its connection, its host or the target's, and the forwarded headers.
   * @param req Incoming request.
   * @param server The server.
   * @param target The target of the server.
   * @param client The address of the client, never taken from a header.
   * @param upgrade Whether the request asks for a WebSocket upgrade.
   * @returns The request, its body still to send.
   */
  private openRequest (req: ProxyRequest, server: ServerCandidate, target: { url: string, tls: boolean }, client: string | undefined, upgrade: boolean): http.ClientRequest {
    const url = new URL(target.url)
    const headers: OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined && !name.startsWith(':') && !CONNECTION_HEADERS.has(name)) {
        headers[name] = value
      }
    }

    const authorityPort = /:(\d+)$/.exec(String(req.headers[':authority'] ?? req.headers.host ?? ''))?.[1]
    headers.host = server.preserveHost ? requestHost(req) : url.host
    headers['x-forwarded-proto'] = target.tls ? 'https' : 'http'
    headers['x-forwarded-port'] = authorityPort ?? (target.tls ? '443' : '80')
    headers['x-forwarded-ssl'] = target.tls ? 'on' : 'off'
    if (client) {
      headers['x-forwarded-for'] = client
    } else {
      delete headers['x-forwarded-for']
    }
    if (upgrade) {
      headers.connection = 'Upgrade'
      headers.upgrade = req.headers.upgrade
    }

    const path = this.targetPath(url, req.url ?? '/', server)
    logger.debug('Proxy', `${server.slug}:${target.url}`, path)
    const secure = url.protocol === 'https:'
    return (secure ? https : http).request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      method: req.method,
      path,
      headers,
      agent: upgrade ? false : secure ? httpsAgent : httpAgent
    })
  }

  private getMatchServer (host: string, requestUrl: string): ServerCandidate | null {
    const servers = this.serversAvailable.filter(candidate => {
      const hostMatch = !candidate.hosts.length || candidate.hosts.includes(host)
      const pathMatch = !candidate.path || requestUrl.startsWith(candidate.path)
      const pathNotMatch = !candidate.pathNot || !requestUrl.startsWith(candidate.pathNot)
      return hostMatch && pathMatch && pathNotMatch
    })

    servers.sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))

    return servers[0] ?? null
  }

  private nextTarget (server: ServerCandidate): { url: string, tls: boolean } {
    server.roundRobinTargetIndex = (server.roundRobinTargetIndex + 1) % server.targets.length
    return server.targets[server.roundRobinTargetIndex]
  }

  /**
   * Gives the path a request takes on a target: the path of the target, then the requested path
   * without the prefix of the server.
   * @param target The URL of the target.
   * @param requestUrl The requested path.
   * @param server The server.
   * @returns The path on the target.
   */
  private targetPath (target: URL, requestUrl: string, server: ServerCandidate): string {
    let path = server.prefix && requestUrl.startsWith(server.prefix) ? requestUrl.slice(server.prefix.length) : requestUrl
    if (!path.startsWith('/')) {
      path = `/${path}`
    }
    return `${target.pathname.replace(/\/$/, '')}${path}`
  }
}
