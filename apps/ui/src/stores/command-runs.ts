import { shallowRef } from "vue";
import wsStore from "./ws";

/** A command to run in the background. */
export interface CommandRunOptions {
  projectSlug: string | null;
  directorySlug: string | null;
  args: string[];
  env: Record<string, string>;
  killSignal: string | null;
  notifications: boolean;
  name: string;
  /** The command of the directory in the configuration, whose arguments and automation the server uses. */
  command?: string;
  /** Runs the command of the configuration bringing back the folder of the missing project. */
  restore?: boolean;
  /** Runs once the command is finished. */
  onFinished?: () => void;
}

/** The command shown in the dialog. */
export interface CommandRun {
  tag: string;
  title: string;
  onFinished: (() => void) | null;
}

/**
 * Commands run in the background, the one shown in the dialog answering their questions.
 */
class CommandRunsStore {
  current = shallowRef<CommandRun | null>(null);

  /**
   * Starts a command in the background and shows it in the dialog.
   * @param options The command.
   */
  start(options: CommandRunOptions): void {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    wsStore.newCommandStream(options.projectSlug, options.directorySlug, false, options.args, options.env, options.killSignal, options.notifications, options.name, { tag, command: options.command, restore: options.restore });
    this.current.value = { tag, title: options.name, onFinished: options.onFinished ?? null };
  }

  /**
   * Hides the dialog.
   */
  close(): void {
    this.current.value = null;
  }
}

export default new CommandRunsStore();
