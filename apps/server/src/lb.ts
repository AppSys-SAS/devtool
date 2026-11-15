import fs from "node:fs/promises";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { logger } from "@appsys/devtool-shared";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { RuntimeConfig } from "@appsys/devtool-shared";
import { allows, forgetRelayedClient, matchesHost, rememberRelayedClient } from "./access.js";
import { DevtoolDns } from "./dns.js";
import { DevtoolProxy, type ProxyRequest, type ProxyResponse, requestHost } from "./proxy.js";
import { readServerName } from "./sni.js";
import type { LoadBalancerContext } from "./types.js";

/** The load balancer listens on every interface, who reaches each host being decided per host. */
const LB_LISTEN_ADDRESS = "0.0.0.0";
const LOOPBACK_ADDRESS = "127.0.0.1";
const MAX_CLIENT_HELLO_BYTES = 64 * 1024;
const CLIENT_HELLO_TIMEOUT_MS = 10_000;

export class DevtoolLB {
  private readonly serverContext: LoadBalancerContext;

  private readonly proxy: DevtoolProxy;

  private certificates: Record<string, tls.SecureContext>;

  /** The certificate given to clients naming no server: the first one declared, null without any. */
  private defaultCertificate: { cert: string; key: string } | null;

  /** The listening server: the TLS front reading the server names, or the plain HTTP server. */
  private server: net.Server | null;

  /** The HTTP/2 and HTTP/1.1 server behind the TLS front, listening on this machine only. */
  private secureServer: http2.Http2SecureServer | null;

  private isSecure: boolean;

  /** The local DNS, started and reloaded with the load balancer. */
  private readonly dns = new DevtoolDns();

  /**
   * @param serverContext Holds the current configuration.
   */
  private constructor(serverContext: LoadBalancerContext) {
    this.serverContext = serverContext;
    this.proxy = new DevtoolProxy();
    this.certificates = {};
    this.defaultCertificate = null;
    this.server = null;
    this.secureServer = null;
    this.isSecure = false;
  }

  /**
   * Creates the load balancer from the current configuration, without listening yet.
   * @param serverContext Holds the current configuration.
   * @returns The load balancer.
   */
  static async create(serverContext: LoadBalancerContext): Promise<DevtoolLB> {
    const instance = new DevtoolLB(serverContext);
    await instance.reload(serverContext.config);
    await instance.createServer();
    return instance;
  }

  /**
   * Takes a new configuration: routes, certificates and, once listening, the local DNS.
   * @param config The configuration.
   * @returns True when the listening server must be recreated, its port or its security having changed.
   */
  async reload(config: RuntimeConfig): Promise<boolean> {
    const nextSecure = Object.keys(config.loadBalancers).length > 0;
    const currentPort = this.getListeningPort();
    const shouldRecreate = this.server !== null && (this.isSecure !== nextSecure || currentPort !== config.adt.ports.loadBalancer);

    this.proxy.reload(config);
    if (this.server?.listening) {
      await this.dns.apply(config.dns);
    }
    this.certificates = {};
    this.defaultCertificate = null;

    for (const [serverName, options] of Object.entries(config.loadBalancers)) {
      const cert = await this.resolveCertificateInput(options.crt);
      const key = await this.resolveCertificateInput(options.key);

      this.certificates[serverName] = tls.createSecureContext({ cert, key });
      this.defaultCertificate ??= { cert, key };
    }
    if (this.defaultCertificate) {
      this.secureServer?.setSecureContext(this.defaultCertificate);
    }

    return shouldRecreate;
  }

  /**
   * Creates the servers again for a new port or security, listening again when they were.
   */
  async recreate(): Promise<void> {
    if (!this.server) {
      return;
    }
    const wasListening = this.server.listening;
    const port = this.serverContext.config.adt.ports.loadBalancer;
    if (wasListening) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    }
    this.secureServer?.close();
    this.secureServer = null;
    await this.createServer();
    if (wasListening) {
      await this.listen(port);
    }
  }

  /**
   * Starts listening on every interface, then starts the local DNS.
   * @param port The port of the load balancer.
   */
  async listen(port = this.serverContext.config.adt.ports.loadBalancer): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.server?.listen(port, LB_LISTEN_ADDRESS, () => resolve());
    });

    logger.info("LoadBalancer", this.isSecure ? "HTTPS" : "HTTP", `Started on port ${port}`);
    await this.dns.apply(this.serverContext.config.dns);
  }

  private getListeningPort(): number | null {
    if (!this.server) {
      return null;
    }

    const address = this.server.address();
    if (!address || typeof address === "string") {
      return null;
    }

    return address.port;
  }

  /**
   * Creates the servers of the load balancer: with certificates, the TLS front reading the server
   * name of each connection and the HTTP/2 and HTTP/1.1 server it relays them to, listening on this
   * machine; without, a plain HTTP server.
   */
  private async createServer(): Promise<void> {
    this.isSecure = this.defaultCertificate !== null;
    if (!this.defaultCertificate) {
      if (this.serverContext.config.passthrough.length) {
        logger.warn("LoadBalancer", "Passthrough", "Ignored without certificates: it needs TLS");
      }
      const server = http.createServer((req, res) => this.onRequest(req, res));
      server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => this.onUpgrade(req, socket, head));
      this.server = server;
      return;
    }

    const secureServer = http2.createSecureServer({ ...this.defaultCertificate, allowHTTP1: true, SNICallback: this.sniCallback.bind(this) }, (req, res) => this.onRequest(req, res));
    secureServer.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => this.onUpgrade(req, socket, head));
    await new Promise<void>((resolve) => secureServer.listen(0, LOOPBACK_ADDRESS, resolve));
    this.secureServer = secureServer;
    this.server = net.createServer(this.onConnection.bind(this));
  }

  /**
   * Waits for the ClientHello of a TLS connection, then dispatches the connection by its server name.
   * @param socket The connection of the client.
   */
  private onConnection(socket: Socket): void {
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      const serverName = received.length > MAX_CLIENT_HELLO_BYTES ? null : readServerName(received);
      if (serverName === undefined) {
        return;
      }

      socket.off("data", onData);
      socket.pause();
      socket.setTimeout(0);
      this.dispatch(socket, received, serverName);
    };

    socket.on("data", onData);
    socket.on("error", () => socket.destroy());
    socket.setTimeout(CLIENT_HELLO_TIMEOUT_MS, () => socket.destroy());
  }

  /**
   * Forwards a TLS connection untouched to the target of its passthrough host, closes it when the client
   * may not reach its host, or relays it to the HTTP server behind the front, the client address kept.
   * @param socket The connection of the client, paused.
   * @param received The bytes already read from it.
   * @param serverName The server name of its ClientHello, null when it named none.
   */
  private dispatch(socket: Socket, received: Buffer, serverName: string | null): void {
    const passthrough = serverName ? this.serverContext.config.passthrough.find((rule) => rule.hosts.some((pattern) => matchesHost(pattern, serverName))) : undefined;
    if (passthrough) {
      if (!allows(passthrough.access, socket.remoteAddress)) {
        logger.warn("LoadBalancer", serverName ?? "-", `Passthrough refused for ${socket.remoteAddress}`);
        socket.destroy();
        return;
      }

      this.relay(socket, received, passthrough.port, passthrough.host);
      return;
    }

    const access = serverName ? this.proxy.accessOf(serverName) : null;
    if (access && !allows(access, socket.remoteAddress)) {
      logger.warn("LoadBalancer", serverName ?? "-", `Refused for ${socket.remoteAddress}`);
      socket.destroy();
      return;
    }

    const address = this.secureServer?.address();
    if (!address || typeof address === "string") {
      socket.destroy();
      return;
    }
    this.relay(socket, received, address.port, LOOPBACK_ADDRESS, socket.remoteAddress);
  }

  /**
   * Relays a connection to another server, the bytes already read first.
   * @param socket The connection of the client, paused.
   * @param received The bytes already read from it.
   * @param port The port of the server.
   * @param host The address of the server.
   * @param client The client address the server is told of, none for a server outside the devtool.
   */
  private relay(socket: Socket, received: Buffer, port: number, host: string, client?: string): void {
    let localPort: number | undefined;
    const upstream = net.connect(port, host, () => {
      localPort = upstream.localPort;
      if (client) {
        rememberRelayedClient(localPort, client);
      }
      upstream.write(received);
      socket.pipe(upstream).pipe(socket);
      socket.resume();
    });
    upstream.on("close", () => forgetRelayedClient(localPort));
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
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

  /**
   * Proxies a request to the server of its host, or answers 404 when no server serves it.
   * @param req The request, HTTP/1.1 or HTTP/2.
   * @param res Its response.
   */
  private onRequest(req: ProxyRequest, res: ProxyResponse): void {
    if (this.proxy.proxyRequest(req, res)) {
      return;
    }

    logger.warn("LoadBalancer", requestHost(req), "No proxy found");
    res.writeHead(404);
    res.end("404 Not Found");
  }

  /**
   * Proxies a WebSocket upgrade to the server of its host, or closes the connection when no server
   * serves it.
   * @param req The upgrade request.
   * @param socket The connection of the client.
   * @param head The first bytes of the upgraded stream.
   */
  private onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    if (this.proxy.proxyUpgrade(req, socket, head)) {
      return;
    }

    logger.warn("LoadBalancer", requestHost(req), "No proxy found");
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
