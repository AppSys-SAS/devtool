import type { CommandArg, CommandInput, CommandInputValue } from "./types.js";

/**
 * Lists the inputs among the arguments of a command, in order.
 * @param args The arguments of the command.
 * @returns Its inputs, whose positions index the values typed for them.
 */
export function commandInputs(args: CommandArg[]): CommandInput[] {
  return args.filter((arg): arg is CommandInput => typeof arg !== "string");
}

/**
 * Gives the values the inputs of a command start with.
 * @param args The arguments of the command.
 * @returns The default value of each input, in order, empty when it declares none.
 */
export function defaultCommandInputs(args: CommandArg[]): CommandInputValue[] {
  return commandInputs(args).map((input) => input.default ?? "");
}

/**
 * Splits arguments typed on one line, words in single or double quotes kept together.
 * @param text The line.
 * @returns The arguments.
 */
export function splitCommandText(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

/**
 * Gives the arguments an input stands for: a value of its choices, its name for a set flag, the
 * words of a text.
 * @param input The input.
 * @param value The value typed for it.
 * @returns The arguments, none when nothing valid was typed.
 */
function expandInput(input: CommandInput, value: CommandInputValue | undefined): string[] {
  if (input.kind === "flag") {
    return value === true ? [input.name] : [];
  }
  if (input.kind === "text") {
    return typeof value === "string" ? splitCommandText(value) : [];
  }
  return typeof value === "string" && input.choices.some((choice) => choice.value === value) ? [value] : [];
}

/**
 * Builds the arguments of a command, each input replaced by what was typed for it.
 * @param args The arguments of the command.
 * @param values The values of its inputs, in order.
 * @returns The arguments to run.
 */
export function expandCommandArgs(args: CommandArg[], values: CommandInputValue[]): string[] {
  let index = 0;
  return args.flatMap((arg) => (typeof arg === "string" ? [arg] : expandInput(arg, values[index++])));
}

/**
 * Replaces the variables `%{ADT:<NAME>}` of a text in a single pass, values never read again.
 * @param text The text.
 * @param values The value of each variable, by name.
 * @param encode Turns a value into what is written, such as a part of a link.
 * @returns The text, unknown variables left as written.
 */
export function replaceVariables(text: string, values: Record<string, string>, encode: (value: string) => string = (value) => value): string {
  return text.replace(/%\{ADT:([A-Z_]+)\}/g, (variable, name: string) => (Object.hasOwn(values, name) ? encode(values[name]) : variable));
}

/**
 * Lists the choices a command needs that have no valid value.
 * @param args The arguments of the command.
 * @param values The values of its inputs, in order.
 * @returns The names of the missing choices.
 */
export function missingCommandInputs(args: CommandArg[], values: CommandInputValue[]): string[] {
  return commandInputs(args)
    .filter((input, index) => input.kind === "choice" && !input.optional && !expandInput(input, values[index]).length)
    .map((input) => input.name);
}
