import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SECRET_REFERENCE = /^op:\/\//;
const OP_READ_TIMEOUT_MS = 120_000;
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const MAX_OUTPUT_LENGTH = 8192;
const MIN_SCRUBBED_LENGTH = 4;
const SCRUBBED = "••••";

/** An answer the server types when the output of a command asks its question. */
export interface CommandAnswer {
  pattern: RegExp;
  /** The answer, or a 1Password reference read when the command starts. */
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

/** A command ready to start: its references replaced by the values they point to. */
export interface ResolvedCommand {
  args: string[];
  env: Record<string, string>;
  answers: CommandAnswer[];
  /** Every value read, never to be shown. */
  secrets: string[];
}

/**
 * Reads the value of a 1Password reference.
 * @param reference The reference, `op://<vault>/<item>/<field>`.
 * @param account The 1Password account, null for the default one.
 * @returns The value.
 */
async function readReference(reference: string, account: string | null): Promise<string> {
  try {
    const { stdout } = await execFileAsync("op", ["read", "--no-newline", ...(account ? ["--account", account] : []), reference], { timeout: OP_READ_TIMEOUT_MS });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim().split("\n")[0];
    throw new Error(`op read ${reference} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

/**
 * Replaces the 1Password references of a command, its environment and its answers by their values.
 * @param automation What the server does around the command.
 * @param args The arguments of the command.
 * @param env Its environment.
 * @returns The command with the values read.
 */
export async function resolveCommand(automation: CommandAutomation, args: string[], env: Record<string, string>): Promise<ResolvedCommand> {
  const values = new Map<string, string>();
  const resolve = async (value: string): Promise<string> => {
    if (!SECRET_REFERENCE.test(value)) {
      return value;
    }
    if (!values.has(value)) {
      values.set(value, await readReference(value, automation.opAccount));
    }
    return values.get(value)!;
  };

  const resolvedArgs: string[] = [];
  for (const arg of args) {
    resolvedArgs.push(await resolve(arg));
  }
  const resolvedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    resolvedEnv[key] = await resolve(value);
  }
  const answers: CommandAnswer[] = [];
  for (const answer of automation.answers) {
    answers.push({ pattern: answer.pattern, value: await resolve(answer.value) });
  }

  return { args: resolvedArgs, env: resolvedEnv, answers, secrets: [...values.values()].filter((value) => value.length >= MIN_SCRUBBED_LENGTH) };
}

/**
 * Hides values in output.
 * @param text The output.
 * @param secrets The values to hide.
 * @returns The output, each value replaced by a mask.
 */
export function scrub(text: string, secrets: string[]): string {
  return secrets.reduce((current, secret) => current.replaceAll(secret, SCRUBBED), text);
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
   * @returns The answer to type, null when the output asks nothing declared.
   */
  feed(data: string): string | null {
    if (!this._pending.length) {
      return null;
    }

    this._output = `${this._output}${data.replace(ANSI_SEQUENCE, "")}`.slice(-MAX_OUTPUT_LENGTH);
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
