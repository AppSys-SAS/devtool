import net from "node:net";
import { logger } from "@appsys/devtool-shared";

export interface ProxyOptions {
  adtSecurePort?: number;
  proxyPort?: number;
}

export default function runProxy({ adtSecurePort = 6731, proxyPort = 443 }: ProxyOptions = {}): net.Server {
  const server = net.createServer((client) => {
    client.once("data", (buffer) => {
      const upstream = net.createConnection({ host: "127.0.0.1", port: adtSecurePort }, () => {
        upstream.write(buffer);
        client.pipe(upstream).pipe(client);
      });

      upstream.on("error", (error) => {
        logger.debug("Proxy", "Upstream", error.message);
        client.destroy();
      });
    });

    client.on("error", (error) => {
      logger.debug("Proxy", "Client", error.message);
    });
  });

  server.on("error", (error) => {
    logger.error("Proxy", "Server", error.message);
  });

  server.listen(proxyPort, () => {
    logger.info("Proxy", "Server", `Started on port ${proxyPort}`);
  });

  return server;
}
