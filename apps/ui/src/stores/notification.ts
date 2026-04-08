import router from "@/router";

class NotificationStore {
  permission: NotificationPermission;

  private readonly notificationTimers: Record<string, ReturnType<typeof setTimeout> | null>;

  private asked = false;

  constructor() {
    this.permission = window.Notification?.permission ?? "denied";
    this.notificationTimers = {};
  }

  askPermission(): void {
    if (!window.Notification) {
      this.permission = "denied";
      return;
    }

    if (this.permission === "granted" || this.permission === "denied" || this.asked) {
      return;
    }

    this.asked = true;
    void window.Notification.requestPermission().then((permission) => {
      this.permission = permission;
    });
  }

  send(title: string, body: string, route: { name: string; params: Record<string, string> } | null, force = false): void {
    if (!this.shouldSendNotifications(title, force) || !window.Notification) {
      return;
    }

    try {
      const notification = new window.Notification(title, {
        body: this.formatBody(body),
      });

      notification.onclick = () => {
        if (route) {
          void router.push(route);
        }

        try {
          window.focus();
        } catch {
          // No-op
        }

        notification.close();
      };

      setTimeout(() => notification.close(), 2000);
    } catch {
      // No-op.
    }
  }

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
    }, 2000);

    return true;
  }

  private formatBody(body: string): string {
    if (body.length <= 250) {
      return body;
    }
    return `${body.slice(0, 245)}...`;
  }
}

export default new NotificationStore();
