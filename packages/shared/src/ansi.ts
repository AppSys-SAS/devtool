// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[ -/]+[0-~]|\x1b[0-Z\\-~]/g

/**
 * Removes the terminal escape sequences of a text, such as colors, cursor moves or window titles.
 * @param text The text.
 * @returns The plain text.
 */
export function stripAnsi (text: string): string {
  return text.replace(ANSI_SEQUENCE, '')
}
