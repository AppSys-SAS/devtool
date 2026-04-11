import httpProxy from "http-proxy";
import { logger } from "@appsys/devtool-shared";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { RuntimeConfig } from "@appsys/devtool-shared";

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
        roundRobinTargetIndex: targets.length - 1,
      });
    }

    this.serversAvailable = nextServers;
  }

  proxyRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const host = this.getHost(req);
    const url = req.url ?? "/";
    const server = this.getMatchServer(host, url);
    if (!server) {
      return false;
    }

    const target = this.nextTarget(server);
    this.applyForwardedHeaders(req, target);
    this.rewriteRequest(req, server);
    logger.debug("Proxy", `${server.slug}:${target.url}`, req.url ?? "/");

    this.proxy.web(req, res, {
      target: target.url,
    });

    return true;
  }

  proxyUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): boolean {
    const host = this.getHost(req);
    const url = req.url ?? "/";
    const server = this.getMatchServer(host, url);
    if (!server) {
      return false;
    }

    const target = this.nextTarget(server);
    this.applyForwardedHeaders(req, target);
    this.rewriteRequest(req, server);
    logger.debug("Proxy", `${server.slug}:${target.url}`, req.url ?? "/");

    this.proxy.ws(req, socket, head, {
      target: this.toWebSocketTarget(target.url),
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
