import { ref } from "vue";
import type { CdnSessionPayload } from "@appsys/devtool-shared";

/**
 * Sign-in state of the developer on the CDN, and the browser tab of a sign-in in progress.
 */
class SessionStore {
  state = ref<CdnSessionPayload | null>(null);

  private loginWindow: Window | null = null;

  /**
   * Takes the state sent by the server, sending the waiting sign-in tab to the sign-in address, or
   * closing it when the sign-in failed before.
   * @param payload The state, or null once disconnected from the server.
   */
  load(payload: CdnSessionPayload | null): void {
    this.state.value = payload;
    if (!this.loginWindow || this.loginWindow.closed) {
      return;
    }

    if (payload?.pendingLoginUrl) {
      this.loginWindow.location.href = payload.pendingLoginUrl;
      this.loginWindow = null;
    } else if (payload?.error) {
      this.loginWindow.close();
      this.loginWindow = null;
    }
  }

  /**
   * Opens the tab of the sign-in while the click is being handled, so the browser does not block it;
   * it is sent to the sign-in address once the server gives it.
   */
  openLoginWindow(): void {
    this.loginWindow = window.open("", "_blank");
  }
}

export default new SessionStore();
