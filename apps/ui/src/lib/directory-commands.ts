import {
  commandInputs,
  defaultCommandInputs,
  expandCommandArgs,
  missingCommandInputs,
  type CommandArg,
  type CommandInputValue,
  type DirectoryDefinition,
  type DirectoryExtra,
  type ProjectDefinition,
} from "@appsys/devtool-shared";
import commandInputsStore from "@/stores/command-inputs";
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
 * Gives a command line, each input shown as `<name>`.
 * @param args The arguments of the command.
 * @returns The command line.
 */
export function commandLine(args: CommandArg[]): string {
  return args.map((arg) => (typeof arg === "string" ? arg : `<${arg.name}>`)).join(" ");
}

/**
 * Gives the name shown for a command of a directory.
 * @param command The command.
 * @returns Its name, else its command line for the main command, else its slug.
 */
export function commandName(command: DirectoryExtra): string {
  return command.name || (command.slug === "main" ? commandLine(command.args) : command.slug);
}

/**
 * Gives the values of the inputs of a command: those typed in the dialog when asked for, or when its
 * default values leave a required choice empty; its default values otherwise.
 * @param command The command.
 * @param ask Whether the dialog is shown even when the default values are enough.
 * @param run Receives the values.
 */
function withInputs(command: DirectoryExtra, ask: boolean, run: (inputs: CommandInputValue[]) => void): void {
  const defaults = defaultCommandInputs(command.args);
  if (!defaults.length || (!ask && !missingCommandInputs(command.args, defaults).length)) {
    run(defaults);
    return;
  }
  commandInputsStore.ask(command, run);
}

/** How a command of a directory runs. */
export interface RunDirectoryCommandOptions {
  /** Whether the interface then shows the terminal of the command. */
  redirect?: boolean;
  /** The values of its inputs; without them, they are asked in a dialog. */
  inputs?: CommandInputValue[];
  /** Whether the command starts on its own, with its default values when they are enough. */
  automatic?: boolean;
  /** Runs once the command is finished, the command then running in the background. */
  onFinished?: () => void;
}

/**
 * Runs a command of a directory: detached, in the background with its questions in a dialog, or in
 * a terminal, once the values of its inputs are known.
 * @param projectSlug The slug of the project.
 * @param directorySlug The slug of the directory.
 * @param command The command.
 * @param options How it runs.
 */
export function runDirectoryCommand(projectSlug: string, directorySlug: string, command: DirectoryExtra, options: RunDirectoryCommandOptions = {}): void {
  const { redirect = true, inputs, automatic = false, onFinished } = options;
  if (!inputs) {
    withInputs(command, !automatic, (values) => runDirectoryCommand(projectSlug, directorySlug, command, { ...options, inputs: values }));
    return;
  }

  const args = expandCommandArgs(command.args, inputs);
  const name = [commandName(command), ...expandCommandArgs(commandInputs(command.args), inputs)].join(" ");
  if (command.detached) {
    wsStore.newCommandDetached(projectSlug, directorySlug, args, command.env, { command: command.slug, inputs });
    return;
  }

  if (command.prompt || onFinished) {
    commandRunsStore.start({
      projectSlug,
      directorySlug,
      args,
      env: command.env,
      killSignal: command.killSignal,
      notifications: command.notifications,
      name,
      command: command.slug,
      inputs,
      onFinished,
    });
    return;
  }

  wsStore.newCommandStream(
    projectSlug,
    directorySlug,
    false,
    args,
    command.env,
    command.killSignal,
    command.notifications,
    name,
    { redirect, command: command.slug, inputs },
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
      } else if (!directoryStreams.some((stream) => !stream.primary && stream.command === command.slug)) {
        runDirectoryCommand(project.slug, directory.slug, command, { redirect: false, automatic: true });
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
 * Starts the default command of a directory, again with the same values when it already ran; the
 * values of its inputs are its default ones when they are enough, else asked in a dialog.
 * @param projectSlug The slug of the project.
 * @param directory The directory.
 */
export function startDefaultCommand(
  projectSlug: string,
  directory: Pick<DirectoryDefinition, "slug" | "name" | "args" | "env" | "killSignal" | "notifications" | "defaultAction" | "extras">,
): void {
  const streamSlug = configStore.getDirectoryStreamPrimary(projectSlug, directory.slug);
  if (streamSlug) {
    wsStore.updateCommandStream(streamSlug, "start");
    return;
  }

  const args = directory.args;
  if (!args) {
    return;
  }
  const action = directory.defaultAction?.shortcut;
  const command = action?.type === "command" ? directory.extras[action.slug] : undefined;
  const start = (inputs: CommandInputValue[]): void =>
    wsStore.newCommandStream(projectSlug, directory.slug, true, expandCommandArgs(args, inputs), directory.env, directory.killSignal, directory.notifications, directory.name, {
      command: command?.slug,
      inputs,
    });
  if (command) {
    withInputs(command, false, start);
  } else {
    start([]);
  }
}
