import { type Document, isMap, parseDocument } from 'yaml'
import { splitFrontMatter } from './markdown.js'

/** The file describing an agent skill, at the root of its folder. */
export const AGENT_SKILL_FILE = 'SKILL.md'

const SKILL_FILE_PATTERN = /^([^/]+)\/skill\.md$/i
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
const NAME_MAX_LENGTH = 64
const DESCRIPTION_MAX_LENGTH = 1024

/** The fields of the header of an agent skill edited one by one. */
export interface AgentSkillFields {
  name: string
  description: string
}

/** An agent skill read from its `SKILL.md`. */
export interface AgentSkill {
  /** Its name, null when its header gives none. */
  name: string | null
  /** Its description, null when its header gives none. */
  description: string | null
  /** Its instructions, after the header. */
  body: string
  /** Why its header cannot be read as YAML, null when it can. */
  error: string | null
  /** What does not follow the format of agent skills. */
  problems: string[]
}

/**
 * Gives the skill a file of a folder of agent skills describes.
 *
 * @param filePath - The path of the file in the folder of agent skills.
 * @returns The folder of the skill when the file is the `SKILL.md` of a folder at the root, whatever the
 * case of its name, null otherwise.
 */
export function agentSkillFolderOf (filePath: string): string | null {
  return SKILL_FILE_PATTERN.exec(filePath)?.[1] ?? null
}

/**
 * Parses the YAML header of an agent skill.
 *
 * @param header - The text of the header, null when there is none.
 * @returns The YAML document, with why it is not a map, null when it is one or is empty.
 */
function parseHeader (header: string | null): { document: Document, error: string | null } {
  const document = parseDocument(header ?? '')
  const syntaxError = document.errors[0]?.message.split('\n')[0]
  if (syntaxError) {
    return { document, error: `the header is not valid YAML: ${syntaxError}` }
  }
  return { document, error: document.contents !== null && !isMap(document.contents) ? 'the header is not a map' : null }
}

/**
 * Reads an agent skill and checks it against the format of agent skills.
 *
 * @param content - The content of its `SKILL.md`.
 * @param folder - The name of its folder, which its name must repeat.
 * @returns The skill, with what does not follow the format.
 */
export function readAgentSkill (content: string, folder: string): AgentSkill {
  const { frontMatter: header, body } = splitFrontMatter(content)
  if (header === null) {
    return { name: null, description: null, body, error: null, problems: ['the file does not start with a YAML header between --- lines'] }
  }

  const { document, error } = parseHeader(header)
  if (error) {
    return { name: null, description: null, body, error, problems: [error] }
  }

  const name = document.get('name')
  const description = document.get('description')
  const problems: string[] = []
  if (typeof name !== 'string' || !name) {
    problems.push('name is missing')
  } else if (name.length > NAME_MAX_LENGTH || !NAME_PATTERN.test(name)) {
    problems.push(`name must be at most ${NAME_MAX_LENGTH} lowercase letters, digits and single hyphens`)
  } else if (name !== folder) {
    problems.push(`name differs from the folder ${folder}`)
  }
  if (typeof description !== 'string' || !description.trim()) {
    problems.push('description is missing')
  } else if (description.length > DESCRIPTION_MAX_LENGTH) {
    problems.push(`description is longer than ${DESCRIPTION_MAX_LENGTH} characters`)
  }

  return {
    name: typeof name === 'string' ? name : null,
    description: typeof description === 'string' ? description : null,
    body,
    error: null,
    problems
  }
}

/**
 * Sets fields of the header of an agent skill, keeping its other keys, its comments and its body.
 *
 * @param content - The content of its `SKILL.md`.
 * @param fields - The fields to set.
 * @returns The new content, with a header added when there was none.
 * @throws When the header is not a YAML map.
 */
export function withAgentSkillFields (content: string, fields: Partial<AgentSkillFields>): string {
  const { frontMatter: header, body } = splitFrontMatter(content)
  const { document, error } = parseHeader(header)
  if (error) {
    throw new Error(error)
  }

  for (const [key, value] of Object.entries(fields)) {
    document.set(key, value)
  }
  return `---\n${document.toString({ lineWidth: 0 })}---\n${header === null && body ? `\n${body}` : body}`
}

/**
 * Replaces the body of an agent skill, keeping its header as it is written.
 *
 * @param content - The content of its `SKILL.md`.
 * @param body - The new body.
 * @returns The new content.
 */
export function withAgentSkillBody (content: string, body: string): string {
  return `${splitFrontMatter(content).prefix}${body}`
}

/**
 * Gives the content of a new agent skill.
 *
 * @param name - Its name, the name of its folder.
 * @returns The content of its `SKILL.md`.
 */
export function newAgentSkill (name: string): string {
  return withAgentSkillFields(`# ${name}\n`, { name, description: '' })
}
