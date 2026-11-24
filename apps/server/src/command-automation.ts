import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { AUTH_VALUES, type AuthValue } from '@appsys/devtool-auth'
import { stripAnsi } from '@appsys/devtool-shared'
import { parse as parseYaml } from 'yaml'
import { OpTerminal } from './op-terminal.js'

const VALUE_BLOCK = /\{\{\s*(.*?)\s*\}\}/gs
const VALUE_SOURCES = {
  op: /^op:\/\/[^\r\n]+$/,
  file: /^file:\/\/([^#\r\n]+)(?:#(\/[^\r\n]*))?$/,
  shell: /^\$\((.+)\)$/s,
  auth: new RegExp(`^auth://(${AUTH_VALUES.join('|')})$`)
} satisfies Record<string, RegExp>
const MAX_OUTPUT_LENGTH = 8192
const MIN_SCRUBBED_LENGTH = 4
const SCRUBBED = '••••'

/** An answer the server types when the output of a command asks its question. */
export interface CommandAnswer {
  pattern: RegExp
  /** The answer, its value blocks read when its question shows. */
  value: string
}

/** What the server does on its own around a command of the configuration. */
export interface CommandAutomation {
  /** A command whose success makes the command needless, null to always run it. */
  unless: string[] | null
  /** The 1Password account the references are read from, null for the default one. */
  opAccount: string | null
  answers: CommandAnswer[]
}

/** Runs a shell command and gives its standard output, failing when the command fails. */
export type ShellRunner = (command: string) => Promise<string>

/** Gives a value of the signed-in developer, failing when nobody is signed in. */
export type AuthReader = (value: AuthValue) => Promise<string>

/** Where the value blocks of a command are read. */
export interface CommandSecretsOptions {
  /** The 1Password account the references are read from, null for the default one. */
  account: string | null
  /** The folder relative file references are resolved from. */
  folder: string
  /** Runs the shell commands of the substitutions. */
  runShell: ShellRunner
  /** Reads the values of the signed-in developer. */
  readAuth: AuthReader
}

/**
 * Lists the value blocks of a text that none of the value sources reads.
 * @param text The text.
 * @returns Each invalid block, as written.
 */
export function findInvalidValueBlocks (text: string): string[] {
  return [...text.matchAll(VALUE_BLOCK)]
    .filter(([, expression]) => !Object.values(VALUE_SOURCES).some(source => source.test(expression)))
    .map(([block]) => block)
}

/**
 * Parses a YAML, JSON or environment file, its format told by its name.
 * @param file The path of the file.
 * @param content Its content.
 * @returns The parsed document.
 */
function parseValueFile (file: string, content: string): unknown {
  const name = path.basename(file)
  if (/\.ya?ml$/i.test(name)) {
    return parseYaml(content)
  }
  if (/\.json$/i.test(name)) {
    return JSON.parse(content)
  }
  if (/^\.env(\..+)?$|\.env$/i.test(name)) {
    return parseEnv(content)
  }
  throw new Error(`unknown format of ${file}, expected .yml, .yaml, .json or .env`)
}

/**
 * Reads the value blocks of the texts of a command, `{{ op://<vault>/<item>/<field> }}` from
 * 1Password in a terminal of its own, `{{ file://<path>#<pointer> }}` from a file,
 * `{{ $(<command>) }}` from the output of a shell command and `{{ auth://<value> }}` from the
 * signed-in developer, each expression once, and hides every value read from the output.
 */
export class CommandSecrets {
  private readonly _values = new Map<string, string>()

  private _terminal: OpTerminal | null = null

  private readonly _readers: Record<keyof typeof VALUE_SOURCES, (match: RegExpExecArray) => Promise<string>> = {
    op: async match => {
      this._terminal ??= OpTerminal.open(this._options.account)
      return this._terminal.read(match[0])
    },
    file: async match => this.readFile(match[1], match[2] ?? null),
    shell: async match => (await this._options.runShell(match[1])).replace(/[\r\n]+$/, ''),
    auth: async match => this._options.readAuth(match[1] as AuthValue)
  }

  /**
   * @param _options Where the value blocks are read.
   */
  constructor (private readonly _options: CommandSecretsOptions) {}

  /**
   * Replaces the value blocks of a text by their values.
   * @param text The text.
   * @returns The text with the values read.
   */
  async resolve (text: string): Promise<string> {
    let resolved = ''
    let end = 0
    for (const match of text.matchAll(VALUE_BLOCK)) {
      resolved += text.slice(end, match.index) + (await this.read(match[1]))
      end = match.index + match[0].length
    }

    return resolved + text.slice(end)
  }

  /**
   * Closes the 1Password terminal, the next run of the command asking 1Password again.
   */
  close (): void {
    this._terminal?.close()
    this._terminal = null
  }

  /**
   * Hides the values read in output.
   * @param text The output.
   * @returns The output, each value replaced by a mask.
   */
  scrub (text: string): string {
    let scrubbed = text
    for (const value of this._values.values()) {
      if (value.length >= MIN_SCRUBBED_LENGTH) {
        scrubbed = scrubbed.replaceAll(value, SCRUBBED)
      }
    }
    return scrubbed
  }

  /**
   * Gives the value of the expression of a block, read on its first use.
   * @param expression The expression, between the braces.
   * @returns Its value.
   */
  private async read (expression: string): Promise<string> {
    let value = this._values.get(expression)
    if (value === undefined) {
      value = await this.readOnce(expression)
      this._values.set(expression, value)
    }
    return value
  }

  /**
   * Reads the value of the expression of a block.
   * @param expression The expression, between the braces.
   * @returns Its value.
   */
  private async readOnce (expression: string): Promise<string> {
    for (const [source, pattern] of Object.entries(VALUE_SOURCES)) {
      const match = pattern.exec(expression)
      if (match) {
        return this._readers[source as keyof typeof VALUE_SOURCES](match)
      }
    }
    throw new Error(`Unknown value block {{ ${expression} }}`)
  }

  /**
   * Reads a file, or the value a JSON pointer designates in a YAML, JSON or environment file.
   * @param filePath The path of the file, `~/` for the home folder, relative to the folder of the command.
   * @param pointer A JSON pointer such as `/hosts/0/token`, null for the whole file.
   * @returns The content of the file without its trailing newlines, or the value as text.
   */
  private async readFile (filePath: string, pointer: string | null): Promise<string> {
    const file = path.resolve(this._options.folder, filePath.startsWith('~/') ? path.join(os.homedir(), filePath.slice(2)) : filePath)
    const content = await fs.readFile(file, 'utf8')
    if (pointer === null) {
      return content.replace(/[\r\n]+$/, '')
    }

    let value = parseValueFile(file, content)
    const keys = pointer.split('/').slice(1).map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'))
    for (const [index, key] of keys.entries()) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
        throw new Error(`file://${filePath}#${pointer}: no key /${keys.slice(0, index + 1).join('/')}`)
      }
      value = (value as Record<string, unknown>)[key]
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`file://${filePath}#${pointer}: not a text, number or boolean`)
    }
    return String(value)
  }
}

/**
 * Follows the output of a command and gives the answer to type when the output since the previous
 * answer asks one of the declared questions, each answered once, the way expect does.
 */
export class AnswerMatcher {
  private _output = ''

  private readonly _pending: CommandAnswer[]

  /**
   * @param answers The answers, tried in this order.
   */
  constructor (answers: CommandAnswer[]) {
    this._pending = [...answers]
  }

  /**
   * Takes output of the command.
   * @param data The output.
   * @returns The answer to type, its value blocks not read yet, null when the output asks nothing declared.
   */
  feed (data: string): string | null {
    if (!this._pending.length) {
      return null
    }

    this._output = `${this._output}${stripAnsi(data)}`.slice(-MAX_OUTPUT_LENGTH)
    for (const [index, answer] of this._pending.entries()) {
      const match = answer.pattern.exec(this._output)
      if (match) {
        this._output = this._output.slice(match.index + match[0].length)
        return this._pending.splice(index, 1)[0].value
      }
    }
    return null
  }
}
