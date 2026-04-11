import httpProxy from "http-proxy";
import { logger } from "@appsys/devtool-shared";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { RuntimeConfig } from "@appsys/devtool-shared";

interface ServerCandidate {
  slug: string;
  hosts: string[];
  ports: number[];
  path: string | null;
  prefix: string | null;
  pathNot: string | null;
  roundRobinPortIndex: number;
}

export class DevtoolProxy {
  private readonly proxy: httpProxy;

  private serversAvailable: ServerCandidate[];

  constructor() {
    this.proxy = httpProxy.createProxyServer({
      headers: {
        "X-Forwarded-Proto": "https",
      },
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
          nextServers.push({
            slug: `${projectSlug}:${directorySlug}:${serverSlug}`,
            hosts: server.hosts.map((host) => host.toLowerCase()),
            ports: server.ports,
            path: server.path,
            prefix: server.prefix,
            pathNot: server.pathNot,
            roundRobinPortIndex: server.ports.length - 1,
          });
        }
      }
    }

    if (config.adt.host) {
      nextServers.push({
        slug: "DEVTOOL:HTTP",
        hosts: [config.adt.host.toLowerCase()],
        ports: [config.adt.ports.server],
        path: null,
        prefix: null,
        pathNot: null,
        roundRobinPortIndex: 0,
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

    const port = this.nextPort(server);
    this.rewriteRequest(req, server);
    logger.debug("Proxy", `${server.slug}:${port}`, req.url ?? "/");

    this.proxy.web(req, res, {
      target: `http://127.0.0.1:${port}`,
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

    const port = this.nextPort(server);
    this.rewriteRequest(req, server);
    logger.debug("Proxy", `${server.slug}:${port}`, req.url ?? "/");

    this.proxy.ws(req, socket, head, {
      target: `http://127.0.0.1:${port}`,
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

  private nextPort(server: ServerCandidate): number {
    server.roundRobinPortIndex = (server.roundRobinPortIndex + 1) % server.ports.length;
    return server.ports[server.roundRobinPortIndex];
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
}
