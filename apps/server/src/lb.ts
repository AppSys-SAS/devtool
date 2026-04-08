import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { logger } from "@appsys/devtool-shared";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { RuntimeConfig } from "@appsys/devtool-shared";
import { DevtoolProxy } from "./proxy.js";
import type { DevtoolServer } from "./server.js";

type AnyLbServer = http.Server | https.Server;

export class DevtoolLB {
  private readonly serverContext: DevtoolServer;

  private readonly proxy: DevtoolProxy;

  private certificates: Record<string, tls.SecureContext>;

  private server: AnyLbServer | null;

  private isSecure: boolean;

  private constructor(serverContext: DevtoolServer) {
    this.serverContext = serverContext;
    this.proxy = new DevtoolProxy();
    this.certificates = {};
    this.server = null;
    this.isSecure = false;
  }

  static async create(serverContext: DevtoolServer): Promise<DevtoolLB> {
    const instance = new DevtoolLB(serverContext);
    await instance.reload(serverContext.config);
    await instance.createServer();
    return instance;
  }

  async reload(config: RuntimeConfig): Promise<void> {
    this.proxy.reload(config);
    this.certificates = {};

    for (const [serverName, options] of Object.entries(config.loadBalancers)) {
      const cert = await this.resolveCertificateInput(options.crt);
      const key = await this.resolveCertificateInput(options.key);

      this.certificates[serverName] = tls.createSecureContext({ cert, key });
    }
  }

  async recreate(): Promise<void> {
    if (!this.server) {
      return;
    }
    const wasListening = this.server.listening;
    const port = this.serverContext.config.gce.ports.loadBalancer;
    if (wasListening) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    }
    await this.createServer();
    if (wasListening) {
      await this.listen(port);
    }
  }

  async listen(port = this.serverContext.config.gce.ports.loadBalancer): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.server?.listen(port, "0.0.0.0", () => resolve());
    });

    logger.info("LoadBalancer", this.isSecure ? "HTTPS" : "HTTP", `Started on port ${port}`);
  }

  private async createServer(): Promise<void> {
    const certificateNames = Object.keys(this.certificates);
    const secureEnabled = certificateNames.length > 0;

    if (secureEnabled) {
      const firstDomain = certificateNames[0];
      const options = this.serverContext.config.loadBalancers[firstDomain];
      const cert = await this.resolveCertificateInput(options.crt);
      const key = await this.resolveCertificateInput(options.key);
      this.server = https.createServer(
        {
          cert,
          key,
          SNICallback: this.sniCallback.bind(this),
        },
        this.onRequest.bind(this),
      );
      this.server.on("upgrade", this.onUpgrade.bind(this));
      this.isSecure = true;
      return;
    }

    this.server = http.createServer(this.onRequest.bind(this));
    this.server.on("upgrade", this.onUpgrade.bind(this));
    this.isSecure = false;
  }

  private async resolveCertificateInput(input: string): Promise<string> {
    try {
      const stat = await fs.stat(input);
      if (stat.isFile()) {
        return fs.readFile(input, "utf-8");
      }
      return input;
    } catch {
      return input;
    }
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const host = (req.headers.host ?? "").split(":")[0] ?? "";
    req.headers.host = host;

    if (this.proxy.proxyRequest(req, res)) {
      return;
    }

    logger.warn("LoadBalancer", host, "No proxy found");
    res.writeHead(404);
    res.end("404 Not Found");
  }

  private onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const host = (req.headers.host ?? "").split(":")[0] ?? "";
    req.headers.host = host;

    if (this.proxy.proxyUpgrade(req, socket, head)) {
      return;
    }

    logger.warn("LoadBalancer", host, "No proxy found");
    socket.destroy();
  }

  private sniCallback(serverName: string, callback?: (error: Error | null, context?: tls.SecureContext) => void): tls.SecureContext | void {
    const host = `.${serverName.split(":")[0]}`;
    let context: tls.SecureContext | undefined;

    for (const [certificateHost, certificateContext] of Object.entries(this.certificates)) {
      if (host.endsWith(certificateHost)) {
        context = certificateContext;
        break;
      }
    }

    if (!context) {
      logger.error("LoadBalancer", serverName, `SSL certificate not found for host ${host}`);
      if (callback) {
        callback(new Error(`SSL certificate not found for host ${host}`));
      }
      return undefined;
    }

    if (callback) {
      callback(null, context);
      return undefined;
    }

    return context;
  }
}
