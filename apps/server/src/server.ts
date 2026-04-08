import type { RuntimeConfig } from "@appsys/devtool-shared";
import { logger } from "@appsys/devtool-shared";
import type { WebSocket } from "ws";
import { DevtoolCommandStream } from "./command-stream.js";
import { DevtoolConfigure } from "./configure.js";
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

  private lb: DevtoolLB;

  private commandStreams: DevtoolCommandStream[];

  private constructor(configProvider: ConfigProvider, version: string) {
    this.configProvider = configProvider;
    this.version = version;
    this.configWrapper = new DevtoolConfigure({});
    this.config = this.configWrapper.runtimeConfig;
    this.http = null as unknown as DevtoolHttp;
    this.lb = null as unknown as DevtoolLB;
    this.commandStreams = [];
  }

  static async run(configProvider: ConfigProvider, version: string): Promise<DevtoolServer> {
    const instance = new DevtoolServer(configProvider, version);
    await instance.loadConfig();
    await instance.createHttp();
    await instance.createLB();
    await instance.listen();
    return instance;
  }

  async onNewConnection(ws: WebSocket): Promise<void> {
    await this.http.sendToWsConnections("config", this.configWrapper.getForClient(this.version), ws);
    for (const stream of this.commandStreams) {
      await stream.sendUpdate(ws);
      await stream.sendOutput(null, ws);
    }
  }

  async onConnectionMessage(type: string, data: unknown, ws: WebSocket): Promise<void> {
    const message = { type, data } as ConnectionMessage;

    if (message.type === "reconfigure") {
      await this.reconfigure();
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

  async removeCommandStream(streamSlug: string): Promise<void> {
    this.commandStreams = this.commandStreams.filter((stream) => stream.slug !== streamSlug);
  }

  private async reconfigure(): Promise<void> {
    await this.loadConfig();
    await this.lb.reload(this.config);
    await this.lb.recreate();
    await this.http.sendToWsConnections("config", this.configWrapper.getForClient(this.version));
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

  private async listen(): Promise<void> {
    await this.http.listen();
    await this.lb.listen();
  }
}
