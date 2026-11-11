import type { DirectoryDefinition, DirectoryExtra } from "@appsys/devtool-shared";
import commandRunsStore from "@/stores/command-runs";
import configStore from "@/stores/config";
import wsStore from "@/stores/ws";

/**
 * Gives the icon declared in the metadata of a project, a directory or a command.
 * @param meta The metadata.
 * @param fallback The icon used when none is declared.
 * @returns Its Iconify name, a bare name being taken from Lucide.
 */
export function iconFromMeta(meta: unknown, fallback = "ph:terminal"): string {
  const icon = typeof meta === "object" && meta !== null ? (meta as { icon?: unknown }).icon : null;
  if (typeof icon !== "string" || !icon.trim()) {
    return fallback;
  }

  return icon.includes(":") ? icon.trim() : `lucide:${icon.trim()}`;
}

/**
 * Gives the name shown for a command of a directory.
 * @param command The command.
 * @returns Its name, else its arguments for the main command, else its slug.
 */
export function commandName(command: DirectoryExtra): string {
  return command.name || (command.slug === "main" ? command.args.join(" ") : command.slug);
}

/**
 * Runs a command of a directory: detached, in the background with its questions in a dialog, or in
 * a terminal.
 * @param projectSlug The slug of the project.
 * @param directorySlug The slug of the directory.
 * @param command The command.
 */
export function runDirectoryCommand(projectSlug: string, directorySlug: string, command: DirectoryExtra): void {
  if (command.detached) {
    wsStore.newCommandDetached(projectSlug, directorySlug, command.args, command.env);
    return;
  }

  if (command.prompt) {
    commandRunsStore.start({
      projectSlug,
      directorySlug,
      args: command.args,
      env: command.env,
      killSignal: command.killSignal,
      notifications: command.notifications,
      name: commandName(command),
      command: command.slug,
    });
    return;
  }

  wsStore.newCommandStream(
    projectSlug,
    directorySlug,
    false,
    command.args,
    command.env,
    command.killSignal,
    command.notifications,
    commandName(command),
    { redirect: true, command: command.slug },
  );
}

/**
 * Starts the default command of a directory, again when it already ran.
 * @param projectSlug The slug of the project.
 * @param directory The directory.
 */
export function startDefaultCommand(
  projectSlug: string,
  directory: Pick<DirectoryDefinition, "slug" | "name" | "args" | "env" | "killSignal" | "notifications">,
): void {
  const streamSlug = configStore.getDirectoryStreamPrimary(projectSlug, directory.slug);
  if (streamSlug) {
    wsStore.updateCommandStream(streamSlug, "start");
    return;
  }

  if (directory.args) {
    wsStore.newCommandStream(projectSlug, directory.slug, true, directory.args, directory.env, directory.killSignal, directory.notifications, directory.name);
  }
}
