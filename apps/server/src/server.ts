import type { FilePayload, FileTreePayload, RuntimeConfig, ScriptsPayload } from "@appsys/devtool-shared";
import { logger } from "@appsys/devtool-shared";
import type { WebSocket } from "ws";
import { DevtoolCdnSession } from "./cdn-session.js";
import type { CommandAutomation } from "./command-automation.js";
import { DevtoolCommandStream } from "./command-stream.js";
import { DevtoolConfigure } from "./configure.js";
import { DevtoolEnvironment } from "./environment.js";
import { DevtoolFileSpaces, type FileSpace, isDevtoolConfig } from "./file-spaces.js";
import { DevtoolHttp } from "./http.js";
import { DevtoolLB } from "./lb.js";
import { listScripts } from "./scripts.js";
import type {
  CommandStreamCreatePayload,
  CommandStreamInputPayload,
  CommandStreamResizePayload,
  CommandStreamUpdatePayload,
  ConfigProvider,
  ConnectionMessage,
} from "./types.js";

/**
 * Describes a file asked for in a file space that does not exist.
 * @param spaceId The identifier of the space.
 * @param filePath The path of the file.
 * @returns The file, with the error.
 */
function unknownSpaceFile(spaceId: string, filePath: string): FilePayload {
  return { space: spaceId, path: filePath, content: null, binary: false, updatedAt: null, saved: false, conflict: false, error: `${spaceId} is not a file space` };
}

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

  private readonly fileSpaces = new DevtoolFileSpaces();

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

    if (message.type === "envDismissRun") {
      await this.environment.dismissRun();
      return;
    }

    if (message.type === "filesList") {
      await this.sendFileTree(message.data.space, ws);
      return;
    }

    if (message.type === "fileRead") {
      const space = this.fileSpaces.get(message.data.space);
      await this.http.sendToWsConnections("file", space ? await space.read(message.data.path) : unknownSpaceFile(message.data.space, message.data.path), ws);
      return;
    }

    if (message.type === "fileWrite") {
      await this.writeFile(message.data.space, message.data.path, message.data.content, message.data.baseUpdatedAt, ws);
      return;
    }

    if (message.type === "fileCreate") {
      const { path, kind } = message.data;
      await this.changeFiles(message.data.space, ws, (space) => space.create(path, kind));
      return;
    }

    if (message.type === "fileRemove") {
      const { path } = message.data;
      await this.changeFiles(message.data.space, ws, (space) => space.remove(path));
      return;
    }

    if (message.type === "fileRename") {
      const { from, to } = message.data;
      await this.changeFiles(message.data.space, ws, (space) => space.rename(from, to));
      return;
    }

    if (message.type === "scriptsList") {
      await this.http.sendToWsConnections("scripts", await this.scripts(message.data.projectSlug, message.data.directorySlug), ws);
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

  /**
   * Sends the files of a space to one interface, or to every interface.
   * @param spaceId The identifier of the space.
   * @param ws The connection of the interface, every connection when omitted.
   * @param error Why a change of the files was refused, if it was.
   */
  private async sendFileTree(spaceId: string, ws?: WebSocket, error: string | null = null): Promise<void> {
    const space = this.fileSpaces.get(spaceId);
    const tree: FileTreePayload = space
      ? await space.tree()
      : { space: spaceId, root: "", exists: false, editable: false, entries: [], error: `${spaceId} is not a file space` };
    await this.http.sendToWsConnections("fileTree", error ? { ...tree, error } : tree, ws);
  }

  /**
   * Writes a file, sends its new state to the interface that asked, then, once written, the files of
   * its space to every interface before running what the space does after a write.
   * @param spaceId The identifier of the space.
   * @param filePath The path of the file.
   * @param content Its new content.
   * @param baseUpdatedAt Last change of the file the content was edited from.
   * @param ws The connection of the interface.
   */
  private async writeFile(spaceId: string, filePath: string, content: string, baseUpdatedAt: string | null, ws: WebSocket): Promise<void> {
    const space = this.fileSpaces.get(spaceId);
    const file = space ? await space.write(filePath, content, baseUpdatedAt) : unknownSpaceFile(spaceId, filePath);
    await this.http.sendToWsConnections("file", file, ws);
    if (!space || !file.saved) {
      return;
    }

    await this.sendFileTree(spaceId);
    await space.afterWrite?.(filePath);
  }

  /**
   * Changes the files and folders of a space, then sends its files to every interface, or why the
   * change was refused to the interface that asked.
   * @param spaceId The identifier of the space.
   * @param ws The connection of the interface.
   * @param change Changes the files of the space.
   */
  private async changeFiles(spaceId: string, ws: WebSocket, change: (space: FileSpace) => Promise<void>): Promise<void> {
    const space = this.fileSpaces.get(spaceId);
    if (!space) {
      await this.sendFileTree(spaceId, ws);
      return;
    }

    try {
      await change(space);
    } catch (error) {
      await this.sendFileTree(spaceId, ws, error instanceof Error ? error.message : String(error));
      return;
    }
    await this.sendFileTree(spaceId);
  }

  /**
   * Lists the scripts of a directory.
   * @param projectSlug The project of the directory.
   * @param directorySlug The directory.
   * @returns The scripts, or why they could not be listed.
   */
  private async scripts(projectSlug: string, directorySlug: string): Promise<ScriptsPayload> {
    const payload: ScriptsPayload = { projectSlug, directorySlug, scripts: [], error: null };
    const directory = this.config.projects[projectSlug]?.directories[directorySlug];
    if (!directory) {
      return { ...payload, error: `${projectSlug}/${directorySlug} is not a directory` };
    }

    try {
      return { ...payload, scripts: await listScripts(directory) };
    } catch (error) {
      return { ...payload, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Reloads the configuration when a written configuration file belongs to the devtool one, then
   * describes the environment again.
   * @param filePath The path of the file in the configuration files space.
   */
  private async afterConfigWrite(filePath: string): Promise<void> {
    if (isDevtoolConfig(filePath)) {
      await this.reconfigure();
    }
    this.refreshEnvironment();
  }

  /**
   * Finds what the server does on its own around a command of the configuration.
   * @param projectSlug The project of the command.
   * @param directorySlug Its directory.
   * @param commandSlug The command.
   * @returns The automation, null when the command declares none.
   */
  commandAutomation(projectSlug: string, directorySlug: string, commandSlug: string): CommandAutomation | null {
    return this.configWrapper.automations[`${projectSlug}/${directorySlug}/${commandSlug}`] ?? null;
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
    this.fileSpaces.configure(nextConfig.raw, this.config.projects, (filePath) => this.afterConfigWrite(filePath));

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
