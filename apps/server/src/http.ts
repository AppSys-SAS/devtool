import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import mime from 'mime-types'
import { WebSocketServer, type WebSocket } from 'ws'
import { logger } from '@appsys-sas/devtool-shared'
import { serveAppIcon, serveIcons } from './icons.js'
import type { ServerContextLike } from './types.js'
import { LISTEN_ADDRESS } from './utils.js'

const MCP_PATH = '/mcp'

interface WsConnection extends WebSocket {
  isAlive?: boolean
}

export class DevtoolHttp {
  private readonly context: ServerContextLike

  public server: http.Server

  private wss: WebSocketServer

  private constructor (context: ServerContextLike) {
    this.context = context
    this.server = http.createServer((req, res) => {
      void this.onRequest(req, res)
    })
    this.wss = new WebSocketServer({
      server: this.server,
      path: '/ws/'
    })
  }

  /**
   * Creates the HTTP server of the interfaces and listens to their WebSocket connections.
   * @param context The server the messages of the interfaces go to.
   * @returns The HTTP server, not listening yet.
   */
  static create (context: ServerContextLike): DevtoolHttp {
    const instance = new DevtoolHttp(context)
    instance.create()
    return instance
  }

  /**
   * Listens to the WebSocket connections of the interfaces and keeps them alive.
   */
  private create (): void {
    this.wss.on('connection', ws => {
      const wsConnection = ws as WsConnection
      wsConnection.isAlive = true

      wsConnection.on('pong', () => {
        wsConnection.isAlive = true
      })

      wsConnection.on('message', message => {
        void this.onMessage(wsConnection, message as Buffer)
      })

      void this.context.onNewConnection(wsConnection)
    })

    this.setupPingPong()
  }

  /**
   * Hands a message of an interface to the server, logging the ones it cannot read.
   * @param ws The connection of the interface.
   * @param message The raw message, JSON `{ type, data }`.
   */
  private async onMessage (ws: WsConnection, message: Buffer): Promise<void> {
    try {
      const parsed = JSON.parse(message.toString()) as { type: string, data: unknown }
      await this.context.onConnectionMessage(parsed.type, parsed.data, ws)
    } catch (error) {
      logger.warn('HTTP', 'WS message', error instanceof Error ? error.message : 'Unknown WS parsing error')
    }
  }

  async listen (): Promise<void> {
    const port = this.context.config.adt.ports.server
    await new Promise<void>(resolve => {
      this.server.listen(port, LISTEN_ADDRESS, () => resolve())
    })
    logger.info('Server', 'HTTP', `Started on port ${port}`)
  }

  /**
   * Sends a payload to one interface, or to every open interface.
   * @param type The type of the payload.
   * @param data The payload.
   * @param wsInstance The connection of the interface, every connection when null.
   * @returns A promise resolved once the payload is handed to the connections.
   */
  sendToWsConnections (type: string, data: unknown, wsInstance: WebSocket | null = null): Promise<void> {
    const payload = JSON.stringify({ type, data })
    for (const ws of this.wss.clients) {
      if (ws.readyState !== ws.OPEN) {
        continue
      }
      if (wsInstance && ws !== wsInstance) {
        continue
      }
      ws.send(payload)
    }
    return Promise.resolve()
  }

  /**
   * Counts the interfaces connected.
   * @returns The number of open connections.
   */
  clientCount (): number {
    return [...this.wss.clients].filter(ws => ws.readyState === ws.OPEN).length
  }

  /**
   * Answers an HTTP request: the MCP server, icons from the installed icon sets, the icon of the devtool,
   * else the files of the interface, falling back to its index page.
   * @param req The request.
   * @param res Its response.
   */
  private async onRequest (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if ((req.url ?? '/').split('?')[0] === MCP_PATH) {
        await this.context.onMcpRequest(req, res)
        return
      }

      if ((await serveIcons(req.url ?? '/', res)) || (await serveAppIcon(req.url ?? '/', res, this.context.config.adt.icon))) {
        return
      }

      const uiPath = this.context.config.adt.uiPath
      if (!uiPath) {
        res.writeHead(404)
        res.end('No UI path configured')
        return
      }

      const requestUrl = req.url ?? '/'
      const parsedPath = requestUrl.split('?')[0] ?? '/'
      const normalized = path.normalize(parsedPath)
      const resolved = path.resolve(uiPath, `.${normalized}`)

      let filePath = resolved
      if (!filePath.startsWith(path.resolve(uiPath))) {
        filePath = path.resolve(uiPath, 'index.html')
      } else {
        try {
          const stat = await fs.stat(filePath)
          if (stat.isDirectory()) {
            filePath = path.join(filePath, 'index.html')
          }
        } catch {
          filePath = path.resolve(uiPath, 'index.html')
        }
      }

      const content = await fs.readFile(filePath)
      const contentType = mime.lookup(path.extname(filePath)) || 'text/plain'

      res.writeHead(200, { 'content-type': contentType })
      res.end(content)
    } catch (error) {
      logger.error('HTTP', 'Request', error instanceof Error ? error.message : 'Unknown HTTP error')
      res.writeHead(500)
      res.end('Internal server error')
    }
  }

  private setupPingPong (): void {
    const interval = setInterval(() => {
      for (const ws of this.wss.clients as Set<WsConnection>) {
        if (ws.isAlive === false) {
          ws.terminate()
          continue
        }
        ws.isAlive = false
        ws.ping()
      }
    }, 15000)

    this.wss.on('close', () => {
      clearInterval(interval)
    })
  }
}
