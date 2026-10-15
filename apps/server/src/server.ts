import type { RuntimeConfig } from "@appsys/devtool-shared";
import { logger } from "@appsys/devtool-shared";
import type { WebSocket } from "ws";
import { DevtoolCdnSession } from "./cdn-session.js";
import { DevtoolCommandStream } from "./command-stream.js";
import { DevtoolConfigure } from "./configure.js";
import { DevtoolEnvironment } from "./environment.js";
import { DevtoolHttp } from "./http.js";
import { DevtoolLB } from "./lb.js";
import type {
  CommandStreamCreatePayload,
  CommandStreamInputPayload,
  CommandStreamResizePayload,
  CommandStreamUpdatePayload,
  ConfigProvider,
  ConnectionMessage,
} from "./types.js";

export class DevtoolServer {
  private readonly configProvider: ConfigProvider;

  private readonly version: string;

  private configWrapper: DevtoolConfigure;

  public config: RuntimeConfig;

  public http: DevtoolHttp;

  private lb: DevtoolLB | null;

  private commandStreams: DevtoolCommandStream[];

  private readonly cdnSession: DevtoolCdnSession;

  private readonly environment: DevtoolEnvironment;

  /**
   * @param configProvider Loads the configuration.
   * @param version Version of the devtool.
   */
  private constructor(configProvider: ConfigProvider, version: string) {
    this.configProvider = configProvider;
    this.version = version;
    this.configWrapper = new DevtoolConfigure({});
    this.config = this.configWrapper.runtimeConfig;
    this.http = null as unknown as DevtoolHttp;
    this.lb = null;
    this.commandStreams = [];
    this.environment = new DevtoolEnvironment((payload) => this.http.sendToWsConnections("environment", payload));
    this.cdnSession = new DevtoolCdnSession(async (payload) => {
      await this.http.sendToWsConnections("cdnSession", payload);
      if (!payload.pendingLoginUrl) {
        this.refreshEnvironment();
      }
    });
  }

  /**
   * Loads the configuration and starts the server.
   * @param configProvider Loads the configuration.
   * @param version Version of the devtool.
   * @param loadBalancer Whether the load balancer runs in this process.
   * @returns The running server.
   */
  static async run(configProvider: ConfigProvider, version: string, loadBalancer: boolean): Promise<DevtoolServer> {
    const instance = new DevtoolServer(configProvider, version);
    await instance.loadConfig();
    await instance.createHttp();
    if (loadBalancer) {
      await instance.createLB();
    }
    await instance.listen();
    instance.refreshEnvironment();
    return instance;
  }

  /**
   * Sends a new interface the configuration, the CDN sign-in state, the development environment and
   * the command streams.
   * @param ws The connection of the interface.
   */
  async onNewConnection(ws: WebSocket): Promise<void> {
    await this.http.sendToWsConnections("config", this.configWrapper.getForClient(this.version), ws);
    await this.http.sendToWsConnections("cdnSession", await this.cdnSession.status(), ws);
    await this.http.sendToWsConnections("environment", this.environment.state(), ws);
    for (const stream of this.commandStreams) {
      await stream.sendUpdate(ws);
      await stream.sendOutput(null, ws);
    }
  }

  /**
   * Handles a message of an interface.
   * @param type The type of the message.
   * @param data Its payload.
   * @param ws The connection of the interface.
   */
  async onConnectionMessage(type: string, data: unknown, ws: WebSocket): Promise<void> {
    const message = { type, data } as ConnectionMessage;

    if (message.type === "reconfigure") {
      await this.reconfigure();
      return;
    }

    if (message.type === "cdnLogin") {
      void this.cdnSession.login();
      return;
    }

    if (message.type === "cdnLogout") {
      await this.cdnSession.logout();
      return;
    }

    if (message.type === "envRefresh") {
      this.refreshEnvironment();
      return;
    }

    if (message.type === "envPullConfig") {
      if (await this.environment.pullSharedConfig()) {
        await this.reconfigure();
      }
      return;
    }

    if (message.type === "envTables") {
      await this.http.sendToWsConnections("environmentTables", await this.environment.tables(message.data.path), ws);
      return;
    }

    if (message.type === "envKeys") {
      await this.http.sendToWsConnections("environmentKeys", await this.environment.keys(message.data.path), ws);
      return;
    }

    if (message.type === "envRun") {
      this.environment.run(message.data.direction, message.data.targets).catch((error: unknown) => {
        logger.warn("Server", "Environment", `Run failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }

    if (message.type === "newCommandStream") {
      await this.newCommandStream(message.data);
      return;
    }

    if (message.type === "newCommandDetached") {
      await this.newCommandDetached(message.data);
      return;
    }

    if (message.type === "updateCommandStream") {
      await this.updateCommandStream(message.data);
      return;
    }

    if (message.type === "streamInput") {
      await this.streamInput(message.data);
      return;
    }

    if (message.type === "streamResize") {
      await this.streamResize(message.data);
      return;
    }

    logger.warn("Server", "WS", `Unknown message type ${type}`);
    ws.send(JSON.stringify({ type: "error", data: { message: `Unknown WS action type: ${type}` } }));
  }

  /**
   * Describes the development environment again in the background and publishes it.
   */
  private refreshEnvironment(): void {
    this.environment.refresh().catch((error: unknown) => {
      logger.warn("Server", "Environment", `Not described: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async removeCommandStream(streamSlug: string): Promise<void> {
    this.commandStreams = this.commandStreams.filter((stream) => stream.slug !== streamSlug);
  }

  /**
   * Reloads the configuration, applies it to the load balancer when it runs in this process and sends it
   * to the interfaces.
   */
  private async reconfigure(): Promise<void> {
    await this.loadConfig();
    if (this.lb && (await this.lb.reload(this.config))) {
      await this.lb.recreate();
    }
    await this.http.sendToWsConnections("config", this.configWrapper.getForClient(this.version));
    await this.cdnSession.publish();
  }

  private async newCommandStream(data: CommandStreamCreatePayload): Promise<void> {
    const stream = await DevtoolCommandStream.create(this, data, false);
    this.commandStreams.push(stream);
  }

  private async newCommandDetached(data: CommandStreamCreatePayload): Promise<void> {
    await DevtoolCommandStream.create(this, data, true);
  }

  private async updateCommandStream(data: CommandStreamUpdatePayload): Promise<void> {
    const stream = this.commandStreams.find((item) => item.slug === data.streamSlug);
    if (!stream) {
      throw new Error("Command stream not found");
    }
    await stream.update({
      action: data.action,
      options: data.options,
    });
  }

  private async streamInput(data: CommandStreamInputPayload): Promise<void> {
    const stream = this.commandStreams.find((item) => item.slug === data.streamSlug);
    if (!stream) {
      return;
    }
    stream.writeInput(data.data);
  }

  private async streamResize(data: CommandStreamResizePayload): Promise<void> {
    const stream = this.commandStreams.find((item) => item.slug === data.streamSlug);
    if (!stream) {
      return;
    }
    stream.resize(data.cols, data.rows);
  }

  private async loadConfig(): Promise<void> {
    const nextConfig = await this.configProvider();
    this.configWrapper = new DevtoolConfigure(nextConfig.raw);
    await this.configWrapper.reconfigure();
    this.config = this.configWrapper.runtimeConfig;
    this.cdnSession.configure(nextConfig.raw.cdn);
    this.environment.configure(nextConfig.raw);

    if (nextConfig.loadedPaths.length) {
      logger.info("Server", "Config", `Loaded: ${nextConfig.loadedPaths.join(", ")}`);
    } else {
      logger.warn("Server", "Config", "No config file found");
    }
  }

  private async createHttp(): Promise<void> {
    this.http = await DevtoolHttp.create(this);
  }

  private async createLB(): Promise<void> {
    this.lb = await DevtoolLB.create(this);
  }

  /**
   * Starts listening on the server port, and on the load balancer port when it runs in this process.
   */
  private async listen(): Promise<void> {
    await this.http.listen();
    await this.lb?.listen();
  }
}
