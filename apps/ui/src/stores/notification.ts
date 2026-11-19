import type { RouteLocationRaw } from "vue-router";
import router from "@/router";

/** How long a notification that is not kept stays shown. */
const NOTIFICATION_DURATION_MS = 10_000;

/** The shortest delay between two notifications of the same title. */
const NOTIFICATION_INTERVAL_MS = 2000;

/** The icon shown in the notifications. */
const NOTIFICATION_ICON = "/favicon.ico";

/** The lock held by the one tab of the browser that sends the notifications. */
const SENDER_LOCK = "appsys-devtool-notifications";

/** How a notification is sent. */
interface NotificationOptions {
  /** Sends it even when one of the same title was sent shortly before. */
  force?: boolean;
  /** Keeps it until the caller closes it, instead of closing it after a while. */
  persistent?: boolean;
}

/**
 * The notifications of the browser: asks for their permission and sends them, opening a page of the
 * interface when one is clicked. Only one tab of a browser sends them, the next one taking over when
 * it closes.
 */
class NotificationStore {
  private readonly notificationTimers: Record<string, ReturnType<typeof setTimeout> | null> = {};

  private asked = false;

  private _sender = !navigator.locks;

  /**
   * Waits to be the tab sending the notifications, holding the lock as long as the tab lives.
   */
  constructor() {
    void navigator.locks?.request(SENDER_LOCK, () => {
      this._sender = true;
      return new Promise<never>(() => undefined);
    });
  }

  /**
   * Gives the permission of the browser as it stands, which a person may change at any time.
   * @returns The permission, denied without notification support.
   */
  get permission(): NotificationPermission {
    return window.Notification?.permission ?? "denied";
  }

  /**
   * Asks the browser for the permission once, when it was neither given nor refused.
   */
  askPermission(): void {
    if (!window.Notification || this.permission !== "default" || this.asked) {
      return;
    }
    this.asked = true;
    void window.Notification.requestPermission();
  }

  /**
   * Sends a notification from the tab sending them, closed after ten seconds unless it is kept.
   * @param title Its title, two notifications of the same title being sent at most every two seconds.
   * @param body Its text.
   * @param route The page opened when it is clicked, null for none.
   * @param options How it is sent.
   * @returns The notification, null when none was sent.
   */
  send(title: string, body: string, route: RouteLocationRaw | null, options: NotificationOptions = {}): Notification | null {
    if (!window.Notification || !this._sender || !this.shouldSendNotifications(title, options.force ?? false)) {
      return null;
    }

    try {
      const notification = new window.Notification(title, { body: this.formatBody(body), icon: NOTIFICATION_ICON, requireInteraction: options.persistent });
      notification.onclick = () => {
        if (route) {
          void router.push(route);
        }
        window.focus();
        notification.close();
      };
      if (!options.persistent) {
        setTimeout(() => notification.close(), NOTIFICATION_DURATION_MS);
      }
      return notification;
    } catch {
      return null;
    }
  }

  /**
   * Tells whether a notification may be sent: permission given, and none of the same title sent
   * shortly before unless forced.
   * @param name The title of the notification.
   * @param force Whether a recent notification of the same title is ignored.
   * @returns True when it may be sent.
   */
  private shouldSendNotifications(name: string, force: boolean): boolean {
    if (this.permission !== "granted") {
      return false;
    }

    if (force && this.notificationTimers[name]) {
      clearTimeout(this.notificationTimers[name] as ReturnType<typeof setTimeout>);
      this.notificationTimers[name] = null;
    }

    if (this.notificationTimers[name]) {
      return false;
    }

    this.notificationTimers[name] = setTimeout(() => {
      this.notificationTimers[name] = null;
    }, NOTIFICATION_INTERVAL_MS);

    return true;
  }

  /**
   * Shortens the text of a notification.
   * @param body The text.
   * @returns The text, cut after 245 characters.
   */
  private formatBody(body: string): string {
    if (body.length <= 250) {
      return body;
    }
    return `${body.slice(0, 245)}...`;
  }
}

export default new NotificationStore();
