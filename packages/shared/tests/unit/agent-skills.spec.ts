import { describe, expect, it } from 'vitest'
import { AGENT_SKILL_FILE, agentSkillFolderOf, newAgentSkill, readAgentSkill, withAgentSkillBody, withAgentSkillFields } from '../../src/agent-skills.js'

const NAME_PROBLEM = 'name must be at most 64 lowercase letters, digits and single hyphens'

/**
 * Builds the content of a `SKILL.md` with a YAML header.
 *
 * @param header - The lines of the header, without the `---` delimiters.
 * @param body - The text after the header.
 * @returns The content of the file.
 */
function skillFile (header: string, body = ''): string {
  return `---\n${header}\n---\n${body}`
}

describe('AGENT_SKILL_FILE', () => {
  it('names the SKILL.md file', () => {
    expect(AGENT_SKILL_FILE).toBe('SKILL.md')
    expect(agentSkillFolderOf(`review/${AGENT_SKILL_FILE}`)).toBe('review')
  })
})

describe('agentSkillFolderOf', () => {
  it('gives the folder of a SKILL.md at the root of a skill folder, whatever its case', () => {
    expect(agentSkillFolderOf('review/SKILL.md')).toBe('review')
    expect(agentSkillFolderOf('review/skill.md')).toBe('review')
    expect(agentSkillFolderOf('review/SKILL.MD')).toBe('review')
    expect(agentSkillFolderOf('review/Skill.Md')).toBe('review')
  })

  it('gives the folder as written, whatever characters it holds', () => {
    expect(agentSkillFolderOf('Code Review/SKILL.md')).toBe('Code Review')
    expect(agentSkillFolderOf('code.review_v2/SKILL.md')).toBe('code.review_v2')
  })

  it('ignores other files and nested SKILL.md files', () => {
    expect(agentSkillFolderOf('SKILL.md')).toBeNull()
    expect(agentSkillFolderOf('review/README.md')).toBeNull()
    expect(agentSkillFolderOf('review/nested/SKILL.md')).toBeNull()
  })

  it('ignores paths that only look like a SKILL.md', () => {
    expect(agentSkillFolderOf('')).toBeNull()
    expect(agentSkillFolderOf('review')).toBeNull()
    expect(agentSkillFolderOf('review/')).toBeNull()
    expect(agentSkillFolderOf('/SKILL.md')).toBeNull()
    expect(agentSkillFolderOf('review/SKILL.mdx')).toBeNull()
    expect(agentSkillFolderOf('review/SKILL.md.bak')).toBeNull()
    expect(agentSkillFolderOf('review/MY-SKILL.md')).toBeNull()
    expect(agentSkillFolderOf('review/SKILL.md/notes.md')).toBeNull()
    expect(agentSkillFolderOf('review/SKILLxmd')).toBeNull()
  })
})

describe('readAgentSkill', () => {
  it('reads a valid skill', () => {
    const skill = readAgentSkill('---\nname: review\ndescription: Reviews code\n---\nInstructions\n', 'review')

    expect(skill).toEqual({ name: 'review', description: 'Reviews code', body: 'Instructions\n', error: null, problems: [] })
  })

  it('accepts keys other than the name and the description', () => {
    const skill = readAgentSkill(skillFile('name: review\ndescription: d\nlicense: MIT\nallowed-tools: Read\nmetadata:\n  owner: team'), 'review')

    expect(skill.problems).toEqual([])
  })

  it('keeps the whole body, other --- lines included', () => {
    const skill = readAgentSkill(skillFile('name: review\ndescription: d', 'Intro\n---\nMore\n'), 'review')

    expect(skill.body).toBe('Intro\n---\nMore\n')
  })

  it('reads a header that ends the file', () => {
    expect(readAgentSkill('---\nname: review\ndescription: d\n---', 'review'))
      .toEqual({ name: 'review', description: 'd', body: '', error: null, problems: [] })
  })

  it('reads a skill with CRLF line breaks', () => {
    expect(readAgentSkill('---\r\ndescription: Reviews\r\nname: review\r\n---\r\nBody\r\n', 'review'))
      .toEqual({ name: 'review', description: 'Reviews', body: 'Body\r\n', error: null, problems: [] })
  })

  it('reads a multi-line description of a CRLF header without carriage returns', () => {
    expect(readAgentSkill('---\r\nname: review\r\ndescription: |-\r\n  Reviews\r\n  code\r\n---\r\n', 'review').description).toBe('Reviews\ncode')
  })

  it('reads a header whose delimiters end with spaces', () => {
    expect(readAgentSkill('---  \nname: review\ndescription: d\n---\t\nBody', 'review'))
      .toEqual({ name: 'review', description: 'd', body: 'Body', error: null, problems: [] })
  })

  it('reports a file without header', () => {
    expect(readAgentSkill('Instructions', 'review')).toEqual({
      name: null,
      description: null,
      body: 'Instructions',
      error: null,
      problems: ['the file does not start with a YAML header between --- lines']
    })
  })

  it('reports a header that is not closed or not on the first line', () => {
    const unclosed = '---\nname: review\ndescription: d\n'
    const late = '\n---\nname: review\ndescription: d\n---\n'

    expect(readAgentSkill(unclosed, 'review')).toMatchObject({ name: null, body: unclosed, problems: ['the file does not start with a YAML header between --- lines'] })
    expect(readAgentSkill(late, 'review')).toMatchObject({ name: null, body: late, problems: ['the file does not start with a YAML header between --- lines'] })
  })

  it('reports an empty file', () => {
    expect(readAgentSkill('', 'review').problems).toEqual(['the file does not start with a YAML header between --- lines'])
  })

  it('reports a header that is not valid YAML', () => {
    const skill = readAgentSkill('---\ndescription: a: b\n---\nBody', 'review')

    expect(skill.error).toMatch(/^the header is not valid YAML: /)
    expect(skill).toMatchObject({ name: null, description: null, body: 'Body', problems: [skill.error] })
  })

  it('reports the first YAML error on a single line', () => {
    const skill = readAgentSkill(skillFile('name: a\nname: b\ndescription: d'), 'a')

    expect(skill.error).toMatch(/^the header is not valid YAML: Map keys must be unique/)
    expect(skill.error).not.toContain('\n')
    expect(skill.problems).toEqual([skill.error])
  })

  it('reports a header that is not a map', () => {
    for (const header of ['- a', 'review', '42', 'null', '~']) {
      expect(readAgentSkill(skillFile(header, 'Body'), 'review'))
        .toEqual({ name: null, description: null, body: 'Body', error: 'the header is not a map', problems: ['the header is not a map'] })
    }
  })

  it('reports missing fields', () => {
    expect(readAgentSkill('---\nlicense: MIT\n---\n', 'review').problems).toEqual(['name is missing', 'description is missing'])
  })

  it('reports missing fields of an empty header or a header of comments', () => {
    for (const content of ['---\n---\nBody', skillFile('# Owned by the team', 'Body')]) {
      expect(readAgentSkill(content, 'review'))
        .toEqual({ name: null, description: null, body: 'Body', error: null, problems: ['name is missing', 'description is missing'] })
    }
  })

  it('reports a name that is empty or not a string', () => {
    expect(readAgentSkill(skillFile('name: ""\ndescription: d'), 'review')).toMatchObject({ name: '', problems: ['name is missing'] })
    for (const name of ['', '123', 'true', '[review]', '{ a: b }']) {
      expect(readAgentSkill(skillFile(`name: ${name}\ndescription: d`), 'review')).toMatchObject({ name: null, problems: ['name is missing'] })
    }
  })

  it('accepts names of lowercase letters, digits and single hyphens up to 64 characters', () => {
    for (const name of ['a', '7', 'review', 'code-review', 'v2', '2fa-check', 'a-b-c', 'a'.repeat(64)]) {
      expect(readAgentSkill(skillFile(`name: ${JSON.stringify(name)}\ndescription: d`), name).problems).toEqual([])
    }
  })

  it('reports a name that breaks the format', () => {
    for (const name of ['Review', 'code--review', '-review', 'review-', 'code_review', 'code review', 'code.review', 'revïew', 'a'.repeat(65)]) {
      expect(readAgentSkill(skillFile(`name: ${JSON.stringify(name)}\ndescription: d`), name).problems).toEqual([NAME_PROBLEM])
    }
  })

  it('reports a name that differs from the folder, case included', () => {
    expect(readAgentSkill(skillFile('name: review\ndescription: d'), 'other').problems).toEqual(['name differs from the folder other'])
    expect(readAgentSkill(skillFile('name: review\ndescription: d'), 'Review').problems).toEqual(['name differs from the folder Review'])
  })

  it('reports only the format of a name that also differs from the folder', () => {
    expect(readAgentSkill(skillFile('name: Review\ndescription: d'), 'other').problems).toEqual([NAME_PROBLEM])
  })

  it('reports a description that is missing, blank or not a string', () => {
    for (const description of ['', '""', '"  "', '"\\n\\t"', '42', 'false', '[a]']) {
      expect(readAgentSkill(skillFile(`name: review\ndescription: ${description}`), 'review').problems).toEqual(['description is missing'])
    }
    expect(readAgentSkill(skillFile('name: review\ndescription: 42'), 'review').description).toBeNull()
    expect(readAgentSkill(skillFile('name: review\ndescription: "  "'), 'review').description).toBe('  ')
  })

  it('accepts a description of up to 1024 characters', () => {
    expect(readAgentSkill(skillFile(`name: review\ndescription: ${'a'.repeat(1024)}`), 'review').problems).toEqual([])
  })

  it('reports a description longer than 1024 characters', () => {
    expect(readAgentSkill(skillFile(`name: review\ndescription: ${'a'.repeat(1025)}`), 'review').problems)
      .toEqual(['description is longer than 1024 characters'])
  })

  it('reads a description written as a block scalar', () => {
    expect(readAgentSkill(skillFile('name: review\ndescription: >\n  Reviews\n  code'), 'review').description).toBe('Reviews code\n')
    expect(readAgentSkill(skillFile('name: review\ndescription: |-\n  Reviews\n  code'), 'review').description).toBe('Reviews\ncode')
  })

  it('reports the problems of the name and of the description together, the name first', () => {
    expect(readAgentSkill(skillFile(`name: Review\ndescription: ${'a'.repeat(1025)}`), 'review').problems)
      .toEqual([NAME_PROBLEM, 'description is longer than 1024 characters'])
    expect(readAgentSkill(skillFile('name: review'), 'other').problems)
      .toEqual(['name differs from the folder other', 'description is missing'])
  })
})

describe('withAgentSkillFields', () => {
  it('sets fields and keeps the other keys, the comments and the body', () => {
    const content = '---\n# Owned by the team\nname: review\nlicense: MIT\n---\nBody\n'

    expect(withAgentSkillFields(content, { description: 'Reviews: code' }))
      .toBe('---\n# Owned by the team\nname: review\nlicense: MIT\ndescription: "Reviews: code"\n---\nBody\n')
  })

  it('replaces existing fields in place', () => {
    const content = skillFile('name: old\ndescription: Old\nlicense: MIT', 'Body\n')

    expect(withAgentSkillFields(content, { name: 'review', description: 'Reviews code' }))
      .toBe(skillFile('name: review\ndescription: Reviews code\nlicense: MIT', 'Body\n'))
  })

  it('keeps inline and nested comments', () => {
    const content = skillFile('name: review # the name\nmetadata:\n  # owner\n  owner: team\ndescription: old')

    expect(withAgentSkillFields(content, { description: 'new' }))
      .toBe(skillFile('name: review # the name\nmetadata:\n  # owner\n  owner: team\ndescription: new'))
  })

  it('keeps a header of comments', () => {
    const result = withAgentSkillFields(skillFile('# Owned by the team', 'Body'), { name: 'review' })

    expect(result).toMatch(/^---\n# Owned by the team\n/)
    expect(readAgentSkill(result, 'review')).toMatchObject({ name: 'review', body: 'Body' })
  })

  it('keeps a body holding --- lines', () => {
    expect(withAgentSkillFields(skillFile('name: review', 'Intro\n---\nMore\n'), { description: 'd' }))
      .toBe(skillFile('name: review\ndescription: d', 'Intro\n---\nMore\n'))
  })

  it('adds a header to a file without one', () => {
    expect(withAgentSkillFields('Body\n', { name: 'review' })).toBe('---\nname: review\n---\n\nBody\n')
  })

  it('adds a header to an empty file without a blank line after it', () => {
    expect(withAgentSkillFields('', { name: 'review' })).toBe('---\nname: review\n---\n')
  })

  it('fills an empty header without adding a blank line', () => {
    expect(withAgentSkillFields('---\n---\nBody', { name: 'review' })).toBe('---\nname: review\n---\nBody')
  })

  it('quotes values YAML would read as another type or structure', () => {
    const result = withAgentSkillFields(skillFile('license: MIT'), { name: '123', description: '' })

    expect(result).toBe(skillFile('license: MIT\nname: "123"\ndescription: ""'))
    expect(readAgentSkill(result, '123')).toMatchObject({ name: '123', description: '' })
  })

  it('writes a long description on one line', () => {
    const description = 'Reviews code '.repeat(20).trim()

    expect(withAgentSkillFields(skillFile('name: review'), { description })).toBe(skillFile(`name: review\ndescription: ${description}`))
  })

  it('writes a multi-line description that reads back the same', () => {
    const description = 'Reviews code\nwhen asked: always'
    const result = withAgentSkillFields(skillFile('name: review'), { description })

    expect(readAgentSkill(result, 'review')).toMatchObject({ description, problems: [] })
  })

  it('keeps the CRLF line breaks of a file and writes values without carriage returns', () => {
    const content = '---\r\n# Owned by the team\r\nname: old\r\nlicense: MIT\r\n---\r\nBody\r\n'
    const result = withAgentSkillFields(content, { name: 'review', description: 'Reviews code' })

    expect(result).toBe('---\r\n# Owned by the team\r\nname: review\r\nlicense: MIT\r\ndescription: Reviews code\r\n---\r\nBody\r\n')
    expect(readAgentSkill(result, 'review')).toMatchObject({ name: 'review', description: 'Reviews code', body: 'Body\r\n', problems: [] })
  })

  it('writes a multi-line description of a CRLF file that reads back the same', () => {
    const description = 'Reviews code\nwhen asked: always'
    const result = withAgentSkillFields('---\r\nname: review\r\n---\r\nBody\r\n', { description })

    expect(result.replaceAll('\r\n', '')).not.toContain('\n')
    expect(readAgentSkill(result, 'review')).toMatchObject({ description, body: 'Body\r\n', problems: [] })
  })

  it('adds a header with the line breaks of a CRLF file without one', () => {
    expect(withAgentSkillFields('Body\r\n', { name: 'review' })).toBe('---\r\nname: review\r\n---\r\n\r\nBody\r\n')
  })

  it('writes a header after a header that ends the file', () => {
    expect(withAgentSkillFields('---\nname: old\n---', { name: 'review' })).toBe('---\nname: review\n---\n')
  })

  it('refuses a header that is not valid YAML', () => {
    expect(() => withAgentSkillFields('---\ndescription: a: b\n---\n', { name: 'review' })).toThrow(/^the header is not valid YAML: /)
  })

  it('refuses a header that is not a map', () => {
    expect(() => withAgentSkillFields('---\n- a\n---\n', { name: 'review' })).toThrow('the header is not a map')
    expect(() => withAgentSkillFields(skillFile('review'), { name: 'review' })).toThrow('the header is not a map')
  })
})

describe('withAgentSkillBody', () => {
  it('replaces the body and keeps the header as written', () => {
    expect(withAgentSkillBody('---\nname:   review\n---\nOld\n', 'New\n')).toBe('---\nname:   review\n---\nNew\n')
  })

  it('keeps the comments and the delimiters of the header as written', () => {
    expect(withAgentSkillBody('---  \n# Owned by the team\nname: review # the name\n---\nOld', 'New'))
      .toBe('---  \n# Owned by the team\nname: review # the name\n---\nNew')
  })

  it('replaces a body holding --- lines', () => {
    expect(withAgentSkillBody(skillFile('name: review', 'Intro\n---\nMore\n'), 'New')).toBe(skillFile('name: review', 'New'))
  })

  it('empties the body', () => {
    expect(withAgentSkillBody(skillFile('name: review', 'Old\n'), '')).toBe(skillFile('name: review'))
  })

  it('keeps an empty header', () => {
    expect(withAgentSkillBody('---\n---\nOld', 'New')).toBe('---\n---\nNew')
  })

  it('keeps a header that is not valid YAML', () => {
    expect(withAgentSkillBody('---\ndescription: a: b\n---\nOld', 'New')).toBe('---\ndescription: a: b\n---\nNew')
  })

  it('starts the body on its own line after a header that ends the file', () => {
    expect(withAgentSkillBody('---\nname: a\n---', 'New')).toBe('---\nname: a\n---\nNew')
    expect(withAgentSkillBody('---\nname: a\n---  ', 'New')).toBe('---\nname: a\n---  \nNew')
    expect(withAgentSkillBody('---\n---', 'New')).toBe('---\n---\nNew')
  })

  it('ends with a line break a header that ends the file when the body is empty', () => {
    expect(withAgentSkillBody('---\nname: a\n---', '')).toBe('---\nname: a\n---\n')
  })

  it('keeps the CRLF line breaks of the header', () => {
    expect(withAgentSkillBody('---\r\nname: a\r\n---\r\nOld\r\n', 'New\r\n')).toBe('---\r\nname: a\r\n---\r\nNew\r\n')
    expect(withAgentSkillBody('---\r\nname: a\r\n---', 'New')).toBe('---\r\nname: a\r\n---\r\nNew')
  })

  it('gives a skill whose header still reads the same after a header that ends the file', () => {
    const content = withAgentSkillBody('---\nname: review\ndescription: d\n---', 'New\n')

    expect(readAgentSkill(content, 'review')).toEqual({ name: 'review', description: 'd', body: 'New\n', error: null, problems: [] })
  })

  it('replaces the whole text without header', () => {
    expect(withAgentSkillBody('Old', 'New')).toBe('New')
    expect(withAgentSkillBody('', 'New')).toBe('New')
  })

  it('gives a skill whose header still reads the same', () => {
    const content = withAgentSkillBody(skillFile('name: review\ndescription: d', 'Old'), 'New\n')

    expect(readAgentSkill(content, 'review')).toEqual({ name: 'review', description: 'd', body: 'New\n', error: null, problems: [] })
  })
})

describe('newAgentSkill', () => {
  it('gives a skill named after its folder, with an empty description and a title', () => {
    const content = newAgentSkill('review')

    expect(content).toBe('---\nname: review\ndescription: ""\n---\n\n# review\n')
    expect(readAgentSkill(content, 'review').problems).toEqual(['description is missing'])
  })

  it('keeps as a string a name YAML would read as another type', () => {
    for (const name of ['123', 'true', 'null']) {
      const content = newAgentSkill(name)

      expect(content).toBe(`---\nname: "${name}"\ndescription: ""\n---\n\n# ${name}\n`)
      expect(readAgentSkill(content, name)).toMatchObject({ name, problems: ['description is missing'] })
    }
  })

  it('gives a skill whose name and description can then be set', () => {
    const content = withAgentSkillFields(newAgentSkill('code-review'), { description: 'Reviews code' })

    expect(readAgentSkill(content, 'code-review')).toEqual({ name: 'code-review', description: 'Reviews code', body: '\n# code-review\n', error: null, problems: [] })
  })
})
