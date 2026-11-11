import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import mime from "mime-types";
import { WebSocketServer, type WebSocket } from "ws";
import { logger } from "@appsys/devtool-shared";
import type { ServerContextLike } from "./types.js";
import { LISTEN_ADDRESS } from "./utils.js";

interface WsConnection extends WebSocket {
  isAlive?: boolean;
}

export class DevtoolHttp {
  private readonly context: ServerContextLike;

  public server: http.Server;

  private wss: WebSocketServer;

  private constructor(context: ServerContextLike) {
    this.context = context;
    this.server = http.createServer(this.onRequest.bind(this));
    this.wss = new WebSocketServer({
      server: this.server,
      path: "/ws/",
    });
  }

  static async create(context: ServerContextLike): Promise<DevtoolHttp> {
    const instance = new DevtoolHttp(context);
    await instance.create();
    return instance;
  }

  private async create(): Promise<void> {
    this.wss.on("connection", (ws) => {
      const wsConnection = ws as WsConnection;
      wsConnection.isAlive = true;

      wsConnection.on("pong", () => {
        wsConnection.isAlive = true;
      });

      wsConnection.on("message", async (message) => {
        try {
          const parsed = JSON.parse(message.toString()) as { type: string; data: unknown };
          await this.context.onConnectionMessage(parsed.type, parsed.data, wsConnection);
        } catch (error) {
          logger.warn("HTTP", "WS message", error instanceof Error ? error.message : "Unknown WS parsing error");
        }
      });

      void this.context.onNewConnection(wsConnection);
    });

    this.setupPingPong();
  }

  async listen(): Promise<void> {
    const port = this.context.config.adt.ports.server;
    await new Promise<void>((resolve) => {
      this.server.listen(port, LISTEN_ADDRESS, () => resolve());
    });
    logger.info("Server", "HTTP", `Started on port ${port}`);
  }

  async sendToWsConnections(type: string, data: unknown, wsInstance: WebSocket | null = null): Promise<void> {
    const payload = JSON.stringify({ type, data });
    for (const ws of this.wss.clients) {
      if (ws.readyState !== ws.OPEN) {
        continue;
      }
      if (wsInstance && ws !== wsInstance) {
        continue;
      }
      ws.send(payload);
    }
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const uiPath = this.context.config.adt.uiPath;
      if (!uiPath) {
        res.writeHead(404);
        res.end("No UI path configured");
        return;
      }

      const requestUrl = req.url ?? "/";
      const parsedPath = requestUrl.split("?")[0] ?? "/";
      const normalized = path.normalize(parsedPath);
      const resolved = path.resolve(uiPath, `.${normalized}`);

      let filePath = resolved;
      if (!filePath.startsWith(path.resolve(uiPath))) {
        filePath = path.resolve(uiPath, "index.html");
      } else {
        try {
          const stat = await fs.stat(filePath);
          if (stat.isDirectory()) {
            filePath = path.join(filePath, "index.html");
          }
        } catch {
          filePath = path.resolve(uiPath, "index.html");
        }
      }

      const content = await fs.readFile(filePath);
      const contentType = mime.lookup(path.extname(filePath)) || "text/plain";

      res.writeHead(200, { "content-type": contentType });
      res.end(content);
    } catch (error) {
      logger.error("HTTP", "Request", error instanceof Error ? error.message : "Unknown HTTP error");
      res.writeHead(500);
      res.end("Internal server error");
    }
  }

  private setupPingPong(): void {
    const interval = setInterval(() => {
      for (const ws of this.wss.clients as Set<WsConnection>) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 15000);

    this.wss.on("close", () => {
      clearInterval(interval);
    });
  }
}
