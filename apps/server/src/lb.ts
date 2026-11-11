import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { Duplex } from "node:stream";
import tls from "node:tls";
import { logger } from "@appsys/devtool-shared";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { RuntimeConfig } from "@appsys/devtool-shared";
import { allows, matchesHost, rememberClientAddress } from "./access.js";
import { DevtoolDns } from "./dns.js";
import { DevtoolProxy } from "./proxy.js";
import { readServerName } from "./sni.js";
import type { LoadBalancerContext } from "./types.js";

/** The load balancer listens on every interface, who reaches each host being decided per host. */
const LB_LISTEN_ADDRESS = "0.0.0.0";
const MAX_CLIENT_HELLO_BYTES = 64 * 1024;
const CLIENT_HELLO_TIMEOUT_MS = 10_000;

/**
 * Gives a stream that replays the bytes already read from a connection, then carries the rest of it
 * both ways.
 * @param socket The connection, paused.
 * @param received The bytes already read from it.
 * @returns The stream.
 */
function replay(socket: Socket, received: Buffer): Duplex {
  const stream = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk: Buffer, encoding, callback) {
      socket.write(chunk, encoding, callback);
    },
    final(callback) {
      socket.end();
      callback();
    },
    destroy(error, callback) {
      socket.destroy();
      callback(error);
    },
  });
  stream.push(received);
  socket.on("data", (chunk: Buffer) => {
    if (!stream.push(chunk)) {
      socket.pause();
    }
  });
  socket.on("end", () => stream.push(null));
  socket.on("close", () => stream.destroy());
  return stream;
}

export class DevtoolLB {
  private readonly serverContext: LoadBalancerContext;

  private readonly proxy: DevtoolProxy;

  private certificates: Record<string, tls.SecureContext>;

  /** The listening server: the TLS front reading the server names, or the HTTP server itself. */
  private server: net.Server | null;

  /** The HTTP server answering the requests, given its TLS connections by the front. */
  private httpServer: http.Server | null;

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
    this.server = null;
    this.httpServer = null;
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

    for (const [serverName, options] of Object.entries(config.loadBalancers)) {
      const cert = await this.resolveCertificateInput(options.crt);
      const key = await this.resolveCertificateInput(options.key);

      this.certificates[serverName] = tls.createSecureContext({ cert, key });
    }

    return shouldRecreate;
  }

  async recreate(): Promise<void> {
    if (!this.server) {
      return;
    }
    const wasListening = this.server.listening;
    const port = this.serverContext.config.adt.ports.loadBalancer;
    if (wasListening) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    }
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
   * Creates the servers of the load balancer: the HTTP server answering the requests and, with
   * certificates, the TLS front listening before it and reading the server name of each connection.
   */
  private async createServer(): Promise<void> {
    this.httpServer = http.createServer(this.onRequest.bind(this));
    this.httpServer.on("upgrade", this.onUpgrade.bind(this));
    this.isSecure = Object.keys(this.certificates).length > 0;
    if (this.isSecure) {
      this.server = net.createServer(this.onConnection.bind(this));
      return;
    }

    if (this.serverContext.config.passthrough.length) {
      logger.warn("LoadBalancer", "Passthrough", "Ignored without certificates: it needs TLS");
    }
    this.server = this.httpServer;
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
   * may not reach its host, or opens its TLS session for the HTTP server, the client address kept.
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

      const upstream = net.connect(passthrough.port, passthrough.host, () => {
        upstream.write(received);
        socket.pipe(upstream).pipe(socket);
        socket.resume();
      });
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
      return;
    }

    const access = serverName ? this.proxy.accessOf(serverName) : null;
    if (access && !allows(access, socket.remoteAddress)) {
      logger.warn("LoadBalancer", serverName ?? "-", `Refused for ${socket.remoteAddress}`);
      socket.destroy();
      return;
    }

    const tlsSocket = new tls.TLSSocket(replay(socket, received), {
      isServer: true,
      secureContext: Object.values(this.certificates)[0],
      SNICallback: this.sniCallback.bind(this),
      ALPNProtocols: ["http/1.1"],
    });
    rememberClientAddress(tlsSocket, socket.remoteAddress);
    tlsSocket.on("error", () => tlsSocket.destroy());
    this.httpServer?.emit("connection", tlsSocket);
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
