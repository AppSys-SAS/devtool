import type { DirectoryDefinition, DirectoryExtra, ProjectDefinition } from "@appsys/devtool-shared";
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
 * @param redirect Whether the interface then shows the terminal of the command.
 */
export function runDirectoryCommand(projectSlug: string, directorySlug: string, command: DirectoryExtra, redirect = true): void {
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
    { redirect, command: command.slug },
  );
}

/**
 * Starts the commands of a section declared with `startWithSection`, the main command of a directory as
 * its main command, each one only when it does not run already.
 * @param project The section.
 */
export function startSection(project: ProjectDefinition): void {
  const running = configStore.commandStreams.value.filter((stream) => stream.projectSlug === project.slug && stream.status === "RUNNING");
  for (const directory of Object.values(project.directories)) {
    const mainCommand = directory.defaultAction?.shortcut.type === "command" ? directory.defaultAction.shortcut.slug : null;
    for (const command of Object.values(directory.extras).filter((extra) => extra.startWithSection)) {
      const directoryStreams = running.filter((stream) => stream.directorySlug === directory.slug);
      if (command.slug === mainCommand) {
        if (!directoryStreams.some((stream) => stream.primary)) {
          startDefaultCommand(project.slug, directory);
        }
      } else if (!directoryStreams.some((stream) => !stream.primary && stream.args.join("\0") === command.args.join("\0"))) {
        runDirectoryCommand(project.slug, directory.slug, command, false);
      }
    }
  }
}

/**
 * Stops every running command of a section.
 * @param projectSlug The slug of the section.
 */
export function stopSection(projectSlug: string): void {
  for (const stream of configStore.commandStreams.value) {
    if (stream.projectSlug === projectSlug && stream.status === "RUNNING") {
      wsStore.updateCommandStream(stream.slug, "stop");
    }
  }
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
