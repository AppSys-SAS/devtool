import { ref } from "vue";
import type { EnvironmentKeyChoicePayload } from "@appsys/devtool-shared";
import configStore from "./config";
import environmentStore from "./environment";
import sessionStore from "./session";

class WsStore {
  connected = ref(false);

  loading = ref(false);

  error = ref<string | null>(null);

  private socket: WebSocket | null = null;

  /**
   * Opens the connection to the server, leaving the handshake timeout to the browser.
   */
  connect(): void {
    if (this.socket) {
      return;
    }

    this.loading.value = true;
    this.error.value = null;
    this.connected.value = false;
    configStore.loadConfig(null);

    const protocol = `ws${window.location.protocol === "https:" ? "s" : ""}`;
    this.socket = new WebSocket(`${protocol}://${window.location.host}/ws/`);

    this.socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { type: string; data: unknown };
        switch (payload.type) {
          case "config":
            if (this.loading.value || !this.connected.value) {
              this.loading.value = false;
              this.connected.value = true;
            }
            configStore.loadConfig(payload.data as never);
            break;
          case "cdnSession":
            sessionStore.load(payload.data as never);
            break;
          case "environment":
            environmentStore.load(payload.data as never);
            break;
          case "environmentKeys":
            environmentStore.loadKeys(payload.data as never);
            break;
          case "environmentTables":
            environmentStore.loadTables(payload.data as never);
            break;
          case "streamUpdate":
            configStore.streamUpdate(payload.data as never);
            break;
          case "streamRedirect":
            configStore.streamRedirect(payload.data as never);
            break;
          case "streamOutput":
            configStore.streamOutput(payload.data as never);
            break;
          case "streamRemove":
            configStore.streamRemove(payload.data as never);
            break;
          default:
            break;
        }
      } catch {
        // No-op.
      }
    };

    this.socket.onclose = () => {
      if (!this.error.value) {
        this.error.value = "The connection has been lost.";
      }
      this.disconnect(true);
    };

    this.socket.onerror = () => {
      if (!this.error.value) {
        this.error.value = "A connection error has occurred.";
      }
      this.disconnect();
    };
  }

  send(type: string, data: unknown): void {
    this.socket?.send(JSON.stringify({ type, data }));
  }

  newCommandStream(
    projectSlug: string | null,
    directorySlug: string | null,
    primary: boolean,
    args: string[],
    env: Record<string, string>,
    killSignal: string | null,
    notifications: boolean,
    name: string | null = null,
    options: Record<string, unknown> = {},
  ): void {
    this.send("newCommandStream", {
      projectSlug,
      directorySlug,
      primary,
      args,
      env,
      killSignal,
      notifications,
      name: name ?? args.join(" "),
      options,
    });
  }

  newCommandDetached(projectSlug: string, directorySlug: string, args: string[], env: Record<string, string>, options: Record<string, unknown> = {}): void {
    this.send("newCommandDetached", {
      projectSlug,
      directorySlug,
      args,
      env,
      options,
    });
  }

  updateCommandStream(streamSlug: string, action: "start" | "stop" | "restart" | "close", options: Record<string, unknown> = {}): void {
    this.send("updateCommandStream", { streamSlug, action, options });
  }

  streamInput(streamSlug: string, data: string): void {
    this.send("streamInput", { streamSlug, data });
  }

  streamResize(streamSlug: string, cols: number, rows: number): void {
    this.send("streamResize", { streamSlug, cols, rows });
  }

  reconfigure(): void {
    this.send("reconfigure", {});
  }

  /**
   * Asks the server to sign the developer in.
   */
  cdnLogin(): void {
    this.send("cdnLogin", {});
  }

  /**
   * Asks the server to sign the developer out.
   */
  cdnLogout(): void {
    this.send("cdnLogout", {});
  }

  /**
   * Asks the server to download the shared devtool configuration and load it.
   */
  envPullConfig(): void {
    this.send("envPullConfig", {});
  }

  /**
   * Asks the server to describe the development environment again.
   */
  envRefresh(): void {
    this.send("envRefresh", {});
  }

  /**
   * Asks the server for the tables of the local database of an environment item.
   * @param path The path of the item.
   */
  envTables(path: string): void {
    this.send("envTables", { path });
  }

  /**
   * Asks the server for the keys differing between the local and CDN copies of a YAML item.
   * @param path The path of the item.
   */
  envKeys(path: string): void {
    this.send("envKeys", { path });
  }

  /**
   * Asks the server to pull or push environment items.
   * @param direction Whether the CDN copies replace the local ones, or the reverse.
   * @param targets The items, with the tables of the databases and the keys of the YAML files (null for the whole item).
   */
  envRun(direction: "pull" | "push", targets: { path: string; tables: string[] | null; keys: EnvironmentKeyChoicePayload[] | null }[]): void {
    this.send("envRun", { direction, targets });
  }

  /**
   * Asks the server to forget the last finished pull or push.
   */
  envDismissRun(): void {
    this.send("envDismissRun", {});
  }

  disconnect(alreadyClosed = false): void {
    if (!alreadyClosed && this.socket) {
      this.socket.close();
    }
    this.loading.value = false;
    this.connected.value = false;
    this.socket = null;
    configStore.reset();
    sessionStore.load(null);
    environmentStore.load(null);
  }
}

export default new WsStore();
