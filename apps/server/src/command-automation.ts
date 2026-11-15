import { OpTerminal } from "./op-terminal.js";
import { stripAnsi } from "./utils.js";

const VALUE_BLOCK = /\{\{\s*(.*?)\s*\}\}/gs;
const SECRET_REFERENCE = /^op:\/\/\S+$/;
const SHELL_SUBSTITUTION = /^\$\((.+)\)$/s;
const MAX_OUTPUT_LENGTH = 8192;
const MIN_SCRUBBED_LENGTH = 4;
const SCRUBBED = "••••";

/** An answer the server types when the output of a command asks its question. */
export interface CommandAnswer {
  pattern: RegExp;
  /** The answer, its value blocks read when its question shows. */
  value: string;
}

/** What the server does on its own around a command of the configuration. */
export interface CommandAutomation {
  /** A command whose success makes the command needless, null to always run it. */
  unless: string[] | null;
  /** The 1Password account the references are read from, null for the default one. */
  opAccount: string | null;
  answers: CommandAnswer[];
}

/** Runs a shell command and gives its standard output, failing when the command fails. */
export type ShellRunner = (command: string) => Promise<string>;

/**
 * Lists the value blocks of a text that are neither a 1Password reference nor a shell substitution.
 * @param text The text.
 * @returns Each invalid block, as written.
 */
export function findInvalidValueBlocks(text: string): string[] {
  return [...text.matchAll(VALUE_BLOCK)].filter(([, expression]) => !SECRET_REFERENCE.test(expression) && !SHELL_SUBSTITUTION.test(expression)).map(([block]) => block);
}

/**
 * Reads the value blocks of the texts of a command, `{{ op://<vault>/<item>/<field> }}` from
 * 1Password in a terminal of its own and `{{ $(<command>) }}` from the output of a shell command,
 * each expression once, and hides every value read from the output.
 */
export class CommandSecrets {
  private readonly _values = new Map<string, string>();

  private _terminal: OpTerminal | null = null;

  /**
   * @param _account The 1Password account the references are read from, null for the default one.
   * @param _runShell Runs the shell commands of the substitutions.
   */
  constructor(
    private readonly _account: string | null,
    private readonly _runShell: ShellRunner,
  ) {}

  /**
   * Replaces the value blocks of a text by their values.
   * @param text The text.
   * @returns The text with the values read.
   */
  async resolve(text: string): Promise<string> {
    let resolved = "";
    let end = 0;
    for (const match of text.matchAll(VALUE_BLOCK)) {
      resolved += text.slice(end, match.index) + (await this.read(match[1]));
      end = match.index + match[0].length;
    }

    return resolved + text.slice(end);
  }

  /**
   * Closes the 1Password terminal, the next run of the command asking 1Password again.
   */
  close(): void {
    this._terminal?.close();
    this._terminal = null;
  }

  /**
   * Hides the values read in output.
   * @param text The output.
   * @returns The output, each value replaced by a mask.
   */
  scrub(text: string): string {
    let scrubbed = text;
    for (const value of this._values.values()) {
      if (value.length >= MIN_SCRUBBED_LENGTH) {
        scrubbed = scrubbed.replaceAll(value, SCRUBBED);
      }
    }
    return scrubbed;
  }

  /**
   * Gives the value of the expression of a block, read on its first use.
   * @param expression The expression, between the braces.
   * @returns Its value.
   */
  private async read(expression: string): Promise<string> {
    let value = this._values.get(expression);
    if (value === undefined) {
      value = await this.readOnce(expression);
      this._values.set(expression, value);
    }
    return value;
  }

  /**
   * Reads the value of the expression of a block.
   * @param expression The expression, between the braces.
   * @returns Its value.
   */
  private async readOnce(expression: string): Promise<string> {
    if (SECRET_REFERENCE.test(expression)) {
      this._terminal ??= OpTerminal.open(this._account);
      return this._terminal.read(expression);
    }

    const substitution = SHELL_SUBSTITUTION.exec(expression);
    if (substitution) {
      return (await this._runShell(substitution[1])).replace(/[\r\n]+$/, "");
    }

    throw new Error(`Unknown value block {{ ${expression} }}`);
  }
}

/**
 * Follows the output of a command and gives the answer to type when the output since the previous
 * answer asks one of the declared questions, each answered once, the way expect does.
 */
export class AnswerMatcher {
  private _output = "";

  private readonly _pending: CommandAnswer[];

  /**
   * @param answers The answers, tried in this order.
   */
  constructor(answers: CommandAnswer[]) {
    this._pending = [...answers];
  }

  /**
   * Takes output of the command.
   * @param data The output.
   * @returns The answer to type, its value blocks not read yet, null when the output asks nothing declared.
   */
  feed(data: string): string | null {
    if (!this._pending.length) {
      return null;
    }

    this._output = `${this._output}${stripAnsi(data)}`.slice(-MAX_OUTPUT_LENGTH);
    for (const [index, answer] of this._pending.entries()) {
      const match = answer.pattern.exec(this._output);
      if (match) {
        this._output = this._output.slice(match.index + match[0].length);
        return this._pending.splice(index, 1)[0].value;
      }
    }
    return null;
  }
}
