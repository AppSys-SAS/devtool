import http from "node:http";
import https from "node:https";
import httpProxy from "http-proxy";
import { logger } from "@appsys/devtool-shared";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { HostAccess, RuntimeConfig } from "@appsys/devtool-shared";
import { allows, clientAddressOf } from "./access.js";

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

interface ServerCandidate {
  slug: string;
  hosts: string[];
  targets: Array<{
    url: string;
    tls: boolean;
  }>;
  path: string | null;
  prefix: string | null;
  pathNot: string | null;
  preserveHost: boolean;
  access: HostAccess;
  roundRobinTargetIndex: number;
}

function readUiProxyTarget(uiPath: string | undefined): { url: string; tls: boolean } | null {
  if (typeof uiPath !== "string") {
    return null;
  }

  const value = uiPath.trim();
  if (!value.length) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    return {
      url: parsed.toString(),
      tls: parsed.protocol === "https:",
    };
  } catch {
    return null;
  }
}

export class DevtoolProxy {
  private readonly proxy: httpProxy;

  private serversAvailable: ServerCandidate[];

  constructor() {
    this.proxy = httpProxy.createProxyServer({
      ws: true,
      changeOrigin: true,
    });
    this.serversAvailable = [];

    this.proxy.on("error", (error, _req, res) => {
      logger.warn("Proxy", "HTTP", error.message);
      if (!res || !(res as ServerResponse).writeHead) {
        return;
      }
      try {
        (res as ServerResponse).writeHead(503);
        (res as ServerResponse).end("503 Service Unavailable");
      } catch {
        // No-op.
      }
    });
  }

  /**
   * Builds the routes of the configuration: the services of the directories and the interface of the
   * devtool, each with who may reach it.
   * @param config The configuration.
   */
  reload(config: RuntimeConfig): void {
    const nextServers: ServerCandidate[] = [];

    for (const [projectSlug, project] of Object.entries(config.projects)) {
      for (const [directorySlug, directory] of Object.entries(project.directories)) {
        for (const [serverSlug, server] of Object.entries(directory.loadBalancer)) {
          const targets = [
            ...server.ports.map((port) => ({ url: `http://127.0.0.1:${port}`, tls: server.tls })),
            ...server.urls.map((url) => ({ url, tls: server.tls || url.startsWith("https://") })),
          ];

          if (!targets.length) {
            continue;
          }

          nextServers.push({
            slug: `${projectSlug}:${directorySlug}:${serverSlug}`,
            hosts: server.hosts.map((host) => host.toLowerCase()),
            targets,
            path: server.path,
            prefix: server.prefix,
            pathNot: server.pathNot,
            preserveHost: server.preserveHost,
            access: server.access,
            roundRobinTargetIndex: targets.length - 1,
          });
        }
      }
    }

    if (config.adt.host) {
      const uiProxyTarget = readUiProxyTarget(config.adt.uiPath);
      const targets = [uiProxyTarget ?? { url: `http://127.0.0.1:${config.adt.ports.server}`, tls: true }];
      nextServers.push({
        slug: "DEVTOOL:HTTP",
        hosts: [config.adt.host.toLowerCase()],
        targets,
        path: null,
        prefix: null,
        pathNot: null,
        preserveHost: false,
        access: config.adt.access,
        roundRobinTargetIndex: targets.length - 1,
      });
    }

    this.serversAvailable = nextServers;
  }

  /**
   * Tells who reaches a host, whatever the path asked for.
   * @param host The host name, lower case.
   * @returns `network` when some server of the host is reachable from the network, `local` when none
   * is, null when no server serves the host.
   */
  accessOf(host: string): HostAccess | null {
    const servers = this.serversAvailable.filter((candidate) => candidate.hosts.includes(host));
    if (!servers.length) {
      return null;
    }
    return servers.some((server) => server.access === "network") ? "network" : "local";
  }

  /**
   * Proxies an HTTP request to the server matching its host and path, reusing upstream connections,
   * or answers 403 when the client may not reach that server.
   * @param req Incoming request.
   * @param res Response to write to.
   * @returns True when a server matched, the request being proxied or refused.
   */
  proxyRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const host = this.getHost(req);
    const url = req.url ?? "/";
    const server = this.getMatchServer(host, url);
    if (!server) {
      return false;
    }

    const client = clientAddressOf(req.socket);
    if (!allows(server.access, client)) {
      logger.warn("Proxy", server.slug, `Refused for ${client}`);
      res.writeHead(403);
      res.end("403 Forbidden");
      return true;
    }

    const target = this.nextTarget(server);
    this.applyForwardedHeaders(req, target);
    this.rewriteRequest(req, server);
    logger.debug("Proxy", `${server.slug}:${target.url}`, req.url ?? "/");

    this.proxy.web(req, res, {
      target: target.url,
      changeOrigin: !server.preserveHost,
      agent: target.url.startsWith("https:") ? httpsAgent : httpAgent,
    });

    return true;
  }

  /**
   * Proxies a WebSocket upgrade to the server matching its host and path, or closes the connection
   * when the client may not reach that server.
   * @param req Incoming upgrade request.
   * @param socket Connection of the client.
   * @param head First bytes of the upgraded stream.
   * @returns True when a server matched, the upgrade being proxied or refused.
   */
  proxyUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): boolean {
    const host = this.getHost(req);
    const url = req.url ?? "/";
    const server = this.getMatchServer(host, url);
    if (!server) {
      return false;
    }

    const client = clientAddressOf(socket);
    if (!allows(server.access, client)) {
      logger.warn("Proxy", server.slug, `Refused for ${client}`);
      socket.destroy();
      return true;
    }

    const target = this.nextTarget(server);
    this.applyForwardedHeaders(req, target);
    this.rewriteRequest(req, server);
    logger.debug("Proxy", `${server.slug}:${target.url}`, req.url ?? "/");

    this.proxy.ws(req, socket, head, {
      target: this.toWebSocketTarget(target.url),
      changeOrigin: !server.preserveHost,
    });

    return true;
  }

  private getHost(request: IncomingMessage): string {
    const host = request.headers.host ?? "";
    return host.split(":")[0]?.toLowerCase() ?? "";
  }

  private getMatchServer(host: string, requestUrl: string): ServerCandidate | null {
    const servers = this.serversAvailable.filter((candidate) => {
      const hostMatch = !candidate.hosts.length || candidate.hosts.includes(host);
      const pathMatch = !candidate.path || requestUrl.startsWith(candidate.path);
      const pathNotMatch = !candidate.pathNot || !requestUrl.startsWith(candidate.pathNot);
      return hostMatch && pathMatch && pathNotMatch;
    });

    servers.sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0));

    return servers[0] ?? null;
  }

  private nextTarget(server: ServerCandidate): { url: string; tls: boolean } {
    server.roundRobinTargetIndex = (server.roundRobinTargetIndex + 1) % server.targets.length;
    return server.targets[server.roundRobinTargetIndex];
  }

  private rewriteRequest(request: IncomingMessage, server: ServerCandidate): void {
    const rawUrl = request.url ?? "/";
    if (server.prefix && rawUrl.startsWith(server.prefix)) {
      request.url = rawUrl.slice(server.prefix.length);
    }

    if (!(request.url ?? "").startsWith("/")) {
      request.url = `/${request.url ?? ""}`;
    }
  }

  private applyForwardedHeaders(request: IncomingMessage, target: { url: string; tls: boolean }): void {
    const host = request.headers.host ?? "";
    const hostParts = host.split(":");
    const lastHostPart = hostParts.length > 1 ? hostParts[hostParts.length - 1] : null;
    const forwardedPort = lastHostPart && /^\d+$/.test(lastHostPart) ? lastHostPart : target.tls ? "443" : "80";

    request.headers["x-forwarded-proto"] = target.tls ? "https" : "http";
    request.headers["x-forwarded-port"] = forwardedPort;
    const client = clientAddressOf(request.socket);
    if (client) {
      request.headers["x-forwarded-for"] = client;
    } else {
      delete request.headers["x-forwarded-for"];
    }
    request.headers["x-forwarded-ssl"] = target.tls ? "on" : "off";
  }

  private toWebSocketTarget(targetUrl: string): string {
    const parsedUrl = new URL(targetUrl);
    if (parsedUrl.protocol === "http:") {
      parsedUrl.protocol = "ws:";
      return parsedUrl.toString();
    }
    if (parsedUrl.protocol === "https:") {
      parsedUrl.protocol = "wss:";
      return parsedUrl.toString();
    }
    return targetUrl;
  }
}
