import { stripAnsi } from '@appsys-sas/devtool-shared'

/** The answers to a yes/no question, as the question spells them. */
export interface CommandPromptChoice {
  yes: string
  no: string
  /** The answer given by an empty reply, null when there is none. */
  defaultAnswer: 'yes' | 'no' | null
}

/** A question a running command waits an answer to. */
export interface CommandPrompt {
  text: string
  /** Whether the answer must not be shown, the question asking for a password or a passphrase. */
  secret: boolean
  /** The answers of a yes/no question, null for any other question. */
  choice: CommandPromptChoice | null
}

const YES_NO = /[[(]\s*(y(?:es)?)\s*\/\s*(n(?:o)?)\s*(?:\/\s*\[[^\]]*\]\s*)?(?:\[\s*(y(?:es)?|n(?:o)?)\s*\]\s*)?[\])]/i
const SECRET = /pass(?:word|phrase)|secret|(?<![a-z])tokens?(?![a-z])|\bpin\b/i
const QUESTION_END = /[:?\])>]$/

/**
 * Turns terminal output into plain text: escape sequences dropped, and every carriage return
 * rewriting its line.
 * @param output The output chunks, in order.
 * @returns The text.
 */
export function terminalText (output: string[]): string {
  return stripAnsi(output.join(''))
    .replace(/\r+\n/g, '\n')
    .split('\n')
    .map(line => line.slice(line.lastIndexOf('\r') + 1))
    .join('\n')
}

/**
 * Reads the answers of a yes/no question, such as `[Y/n]`, `[y/N]`, `(yes/no/[fingerprint])` or
 * `(y/n [n])`, the default answer given by a capital letter or by the bracketed answer.
 * @param question The question.
 * @returns The answers, or null when the question is not a yes/no one.
 */
function choiceOf (question: string): CommandPromptChoice | null {
  const match = YES_NO.exec(question)
  if (!match) {
    return null
  }

  const [, yes, no, bracketedDefault] = match
  let defaultAnswer: CommandPromptChoice['defaultAnswer'] = null
  if (bracketedDefault) {
    defaultAnswer = /^y/i.test(bracketedDefault) ? 'yes' : 'no'
  } else if (yes.startsWith('Y') && no.startsWith('n')) {
    defaultAnswer = 'yes'
  } else if (yes.startsWith('y') && no.startsWith('N')) {
    defaultAnswer = 'no'
  }
  return { yes: yes.toLowerCase(), no: no.toLowerCase(), defaultAnswer }
}

/**
 * Finds the question a running command waits an answer to: the last line of its output that is not
 * blank, ending like a question.
 * @param text The plain output of the command.
 * @returns The question, or null when the output does not end with one.
 */
export function pendingPrompt (text: string): CommandPrompt | null {
  const trimmed = text.trimEnd()
  const line = trimmed.slice(trimmed.lastIndexOf('\n') + 1).trim()
  if (!QUESTION_END.test(line)) {
    return null
  }

  return { text: line, secret: SECRET.test(line), choice: choiceOf(line) }
}
