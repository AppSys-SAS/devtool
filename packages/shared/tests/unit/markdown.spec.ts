import { describe, expect, it } from 'vitest'
import { splitFrontMatter } from '../../src/markdown.js'

describe('splitFrontMatter', () => {
  it('splits the front matter from the body', () => {
    const content = '---\ntitle: Hello\n---\n# Body\n'

    expect(splitFrontMatter(content)).toEqual({
      frontMatter: 'title: Hello',
      prefix: '---\ntitle: Hello\n---\n',
      body: '# Body\n'
    })
  })

  it('keeps every line of a multi-line front matter', () => {
    const content = '---\nname: review\ndescription: Reviews code\ntags:\n  - a\n  - b\n---\nBody'

    expect(splitFrontMatter(content)).toEqual({
      frontMatter: 'name: review\ndescription: Reviews code\ntags:\n  - a\n  - b',
      prefix: '---\nname: review\ndescription: Reviews code\ntags:\n  - a\n  - b\n---\n',
      body: 'Body'
    })
  })

  it('keeps the whole text as body without front matter', () => {
    expect(splitFrontMatter('# Body\n')).toEqual({ frontMatter: null, prefix: '', body: '# Body\n' })
  })

  it('keeps an empty text as an empty body', () => {
    expect(splitFrontMatter('')).toEqual({ frontMatter: null, prefix: '', body: '' })
  })

  it('keeps the whole text as body when the front matter is not closed', () => {
    expect(splitFrontMatter('---\ntitle: Hello\n# Body')).toEqual({ frontMatter: null, prefix: '', body: '---\ntitle: Hello\n# Body' })
  })

  it.each(['---', '---\n', '--- \r\n'])('does not treat a lone opening marker %j as a closed front matter', content => {
    expect(splitFrontMatter(content)).toEqual({ frontMatter: null, prefix: '', body: content })
  })

  it('only reads a front matter that starts on the first line', () => {
    const content = '\n---\ntitle: Hello\n---\nBody'

    expect(splitFrontMatter(content)).toEqual({ frontMatter: null, prefix: '', body: content })
  })

  it('ignores a separator that appears later in the body', () => {
    const content = '# Title\n\n---\n\nMore text\n---\n'

    expect(splitFrontMatter(content)).toEqual({ frontMatter: null, prefix: '', body: content })
  })

  it.each([' ---', '----', '--', '- - -', '...'])('does not accept %j as an opening marker', marker => {
    const content = `${marker}\ntitle: Hello\n---\nBody`

    expect(splitFrontMatter(content)).toEqual({ frontMatter: null, prefix: '', body: content })
  })

  it.each([' ---', '----', '...'])('does not accept %j as a closing marker', marker => {
    const content = `---\ntitle: Hello\n${marker}\nBody`

    expect(splitFrontMatter(content)).toEqual({ frontMatter: null, prefix: '', body: content })
  })

  it('accepts markers followed by spaces or carriage returns', () => {
    const { frontMatter, body } = splitFrontMatter('--- \r\nname: a\r\n---\r\nbody')

    expect(frontMatter).toBe('name: a')
    expect(body).toBe('body')
  })

  it('accepts markers followed by tabs', () => {
    expect(splitFrontMatter('---\t\nname: a\n---\t \nbody')).toEqual({
      frontMatter: 'name: a',
      prefix: '---\t\nname: a\n---\t \n',
      body: 'body'
    })
  })

  it('keeps the carriage returns of a CRLF text in the prefix and the body', () => {
    expect(splitFrontMatter('---\r\nname: a\r\n---\r\nline 1\r\nline 2\r\n')).toEqual({
      frontMatter: 'name: a',
      prefix: '---\r\nname: a\r\n---\r\n',
      body: 'line 1\r\nline 2\r\n'
    })
  })

  it('removes the carriage return ending every line of a CRLF front matter', () => {
    expect(splitFrontMatter('---\r\nname: a\r\ntags:\r\n  - b\r\n\r\ndescription: c  \r\n---\r\nbody').frontMatter)
      .toBe('name: a\ntags:\n  - b\n\ndescription: c  ')
  })

  it('reads a front matter mixing LF and CRLF lines', () => {
    expect(splitFrontMatter('---\nname: a\r\nkey: b\n---\r\nbody')).toEqual({
      frontMatter: 'name: a\nkey: b',
      prefix: '---\nname: a\r\nkey: b\n---\r\n',
      body: 'body'
    })
  })

  it('keeps the carriage returns inside the front matter lines', () => {
    expect(splitFrontMatter('---\r\nname: a\rb\r\n---\r\nbody').frontMatter).toBe('name: a\rb')
  })

  it('reads a CRLF front matter whose closing marker ends the text', () => {
    expect(splitFrontMatter('---\r\nname: a\r\n---')).toEqual({ frontMatter: 'name: a', prefix: '---\r\nname: a\r\n---', body: '' })
  })

  it('reads an empty front matter', () => {
    expect(splitFrontMatter('---\n---\nbody')).toEqual({ frontMatter: '', prefix: '---\n---\n', body: 'body' })
  })

  it('reads a front matter made of a blank line', () => {
    expect(splitFrontMatter('---\n\n---\nbody')).toEqual({ frontMatter: '', prefix: '---\n\n---\n', body: 'body' })
  })

  it('returns an empty body when the closing marker ends the text', () => {
    expect(splitFrontMatter('---\nname: a\n---')).toEqual({ frontMatter: 'name: a', prefix: '---\nname: a\n---', body: '' })
  })

  it('returns an empty body when the closing marker is followed by a single newline', () => {
    expect(splitFrontMatter('---\nname: a\n---\n')).toEqual({ frontMatter: 'name: a', prefix: '---\nname: a\n---\n', body: '' })
  })

  it('stops the front matter at the first closing marker', () => {
    expect(splitFrontMatter('---\nname: a\n---\nintro\n---\nmore\n')).toEqual({
      frontMatter: 'name: a',
      prefix: '---\nname: a\n---\n',
      body: 'intro\n---\nmore\n'
    })
  })

  it('keeps the blank lines that start the body', () => {
    expect(splitFrontMatter('---\nname: a\n---\n\n\n# Title')).toEqual({
      frontMatter: 'name: a',
      prefix: '---\nname: a\n---\n',
      body: '\n\n# Title'
    })
  })

  it('keeps the indentation and trailing spaces of the front matter lines', () => {
    expect(splitFrontMatter('---\n  name: a  \n\tkey: b\n---\nbody').frontMatter).toBe('  name: a  \n\tkey: b')
  })

  it.each([
    '',
    '# Body\n',
    '---\ntitle: Hello\n---\n# Body\n',
    '--- \r\nname: a\r\n---\r\nbody\r\n',
    '---\r\nname: a\r\ntags:\r\n  - b\r\n---\r\nline 1\r\nline 2\r\n',
    '---\nname: a\r\nkey: b\n---\r\nbody',
    '---\r\nname: a\r\n---',
    '---\n---\n',
    '---\nname: a\n---',
    '---\nname: a\n---\nintro\n---\nmore',
    '---\nunclosed\n'
  ])('rebuilds the original text from the prefix and the body of %j', content => {
    const { prefix, body } = splitFrontMatter(content)

    expect(`${prefix}${body}`).toBe(content)
  })
})
