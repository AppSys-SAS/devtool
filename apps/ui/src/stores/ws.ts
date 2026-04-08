import { ref } from "vue";
import configStore from "./config";

class WsStore {
  connected = ref(false);

  loading = ref(false);

  error = ref<string | null>(null);

  private socket: WebSocket | null = null;

  private connecting: ReturnType<typeof setTimeout> | null = null;

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

    this.connecting = setTimeout(() => {
      if (!this.error.value) {
        this.error.value = "The connection has timed out.";
      }
      this.disconnect();
    }, 2500);

    this.socket.onopen = () => {
      if (this.connecting) {
        clearTimeout(this.connecting);
      }
      this.connecting = null;
    };

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
    configStore.loadConfig(null);
    this.send("reconfigure", {});
  }

  disconnect(alreadyClosed = false): void {
    if (!alreadyClosed && this.socket) {
      this.socket.close();
    }
    this.loading.value = false;
    this.connected.value = false;
    this.socket = null;
    configStore.reset();
  }
}

export default new WsStore();
