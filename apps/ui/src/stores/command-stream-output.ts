import { reactive } from "vue";
import notificationStore from "./notification";
import { getStreamRoute, isCurrentRoute } from "@/router/utils";
import type { CommandStreamLine } from "@/types";

interface OutputChunk {
  date: number;
  type: "stdout" | "stderr" | "stdin" | "info";
  content: string;
}

const MAX_OUTPUT_LINES = 1_000;

export class CommandStreamOutputStore extends EventTarget {
  private readonly defaultNotificationName: string | null;

  slug: string | null = null;

  name: string | null = null;

  projectSlug: string | null = null;

  directorySlug: string | null = null;

  primary = false;

  notificationName: string | null = null;

  route: { name: string; params: Record<string, string> } | null = null;

  output = reactive<CommandStreamLine[]>([]);

  constructor(defaultNotificationName: string | null) {
    super();
    this.defaultNotificationName = defaultNotificationName;
  }

  update({
    slug,
    name,
    projectSlug,
    directorySlug,
    primary,
    notifications,
  }: {
    slug: string;
    name: string;
    projectSlug: string | null;
    directorySlug: string | null;
    primary: boolean;
    notifications: boolean;
  }): void {
    this.slug = slug;
    this.name = name;
    this.projectSlug = projectSlug;
    this.directorySlug = directorySlug;
    this.primary = primary;
    this.notificationName = null;

    if (notifications) {
      notificationStore.askPermission();
      if (this.primary) {
        this.notificationName = this.defaultNotificationName;
      }
      if (!this.notificationName) {
        this.notificationName = this.name ?? this.slug;
      }
    }

    this.route = getStreamRoute(this.projectSlug, this.directorySlug, this.slug, this.primary);
  }

  addOutput(outputs: OutputChunk[], initial = false): boolean {
    for (const output of outputs) {
      const line: CommandStreamLine = {
        type: output.type,
        date: this.convertDate(output.date),
        content: output.content,
      };

      this.output.push(line);

      if (!initial && this.notificationName && output.type === "stderr") {
        notificationStore.send(this.notificationName, output.content, this.route);
      }

      this.dispatchEvent(new CustomEvent("output", { detail: line }));
    }

    while (this.output.length > MAX_OUTPUT_LINES) {
      this.output.shift();
    }

    if (!this.route) {
      return false;
    }

    return !isCurrentRoute(this.route) && !initial;
  }

  clear(): void {
    this.output.splice(0, this.output.length);
  }

  private convertDate(value: number): string {
    const date = new Date(value);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
    return `${hours}:${minutes}:${seconds}:${milliseconds}`;
  }
}
