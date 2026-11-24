/** A Markdown text split around its front matter. */
export interface MarkdownParts {
  /** The text of the YAML front matter, null when there is none. */
  frontMatter: string | null
  /** The text before the body, front matter lines included. */
  prefix: string
  body: string
}

/**
 * Splits a Markdown text into its YAML front matter, between two `---` lines at the top, and its body.
 *
 * @param content - The Markdown text.
 * @returns The front matter and the body.
 */
export function splitFrontMatter (content: string): MarkdownParts {
  const lines = content.split('\n')
  const end = lines[0]?.trimEnd() === '---' ? lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---') : -1
  if (end < 0) {
    return { frontMatter: null, prefix: '', body: content }
  }

  const body = lines.slice(end + 1).join('\n')
  return { frontMatter: lines.slice(1, end).join('\n'), prefix: content.slice(0, content.length - body.length), body }
}
