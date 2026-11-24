import { describe, expect, it } from 'vitest'
import { type ConfigFormat, configFormatOf, countChoices, diffConfig, type KeyChoice, type KeyDifference, mergeConfig, readMap, readYaml } from '../../src/config-merge.js'

/**
 * Gives the format of a file path known to be mergeable.
 *
 * @param filePath - The path of the file.
 * @returns Its format.
 */
function formatOf (filePath: string): ConfigFormat {
  const format = configFormatOf(filePath)
  if (format === null) {
    throw new Error(`${filePath} has no mergeable format`)
  }
  return format
}

/**
 * Compares two copies and merges them onto one side with the given choices.
 *
 * @param filePath - The path naming the format.
 * @param local - The local copy.
 * @param remote - The CDN copy.
 * @param baseSide - The copy the result is built from.
 * @param choices - The value chosen for each key.
 * @returns The merged text.
 */
function merge (filePath: string, local: string, remote: string, baseSide: 'local' | 'remote', choices: KeyChoice[]): string {
  const format = formatOf(filePath)
  const baseText = baseSide === 'local' ? local : remote
  return mergeConfig(format, baseText, baseSide, diffConfig(format, local, remote), choices)
}

/**
 * Reads a dotenv text as a map.
 *
 * @param text - The dotenv text.
 * @returns Its values by key.
 */
function readDotenv (text: string): Record<string, unknown> {
  return formatOf('.env').read(text, 'the file')
}

/**
 * Writes changes onto a dotenv text.
 *
 * @param baseText - The dotenv text.
 * @param changes - The new value of each key, undefined to remove it.
 * @returns The new text.
 */
function writeDotenv (baseText: string, changes: { path: string[], value: unknown }[]): string {
  return formatOf('.env').write(baseText, changes)
}

describe('readYaml', () => {
  it('reads a map', () => {
    expect(readYaml('a: 1\nb:\n  c: text\n', 'the file')).toEqual({ a: 1, b: { c: 'text' } })
  })

  it('reads a list', () => {
    expect(readYaml('- 1\n- two\n', 'the file')).toEqual([1, 'two'])
  })

  it('reads a scalar', () => {
    expect(readYaml('42', 'the file')).toBe(42)
    expect(readYaml('hello', 'the file')).toBe('hello')
  })

  it('reads an empty text as null', () => {
    expect(readYaml('', 'the file')).toBeNull()
  })

  it('names the file in the error for invalid YAML', () => {
    expect(() => readYaml('a: [1, 2\n', 'settings.yml')).toThrow(/^settings\.yml is not valid YAML: /)
  })

  it('rejects duplicate keys', () => {
    expect(() => readYaml('a: 1\na: 2\n', 'settings.yml')).toThrow(/^settings\.yml is not valid YAML: /)
  })
})

describe('readMap', () => {
  it('reads a YAML map', () => {
    expect(readMap('a: 1\nlist:\n  - x\n', 'the file')).toEqual({ a: 1, list: ['x'] })
  })

  it('gives an empty map for an empty file', () => {
    expect(readMap('', 'the file')).toEqual({})
  })

  it('gives an empty map for a file holding only comments', () => {
    expect(readMap('# nothing here\n', 'the file')).toEqual({})
  })

  it('gives an empty map for an explicit null document', () => {
    expect(readMap('~\n', 'the file')).toEqual({})
  })

  it('rejects a list root with the label', () => {
    expect(() => readMap('- a\n', 'settings.yml')).toThrow('settings.yml is not a YAML map')
  })

  it('rejects a scalar root with the label', () => {
    expect(() => readMap('text', 'settings.yml')).toThrow('settings.yml is not a YAML map')
  })

  it('rejects invalid YAML with the label', () => {
    expect(() => readMap('a: "open\n', 'settings.yml')).toThrow(/^settings\.yml is not valid YAML: /)
  })
})

describe('configFormatOf', () => {
  it('gives no format for a file whose keys cannot be merged', () => {
    expect(configFormatOf('notes.txt')).toBeNull()
  })

  it('gives the same YAML format for both YAML extensions', () => {
    const yaml = configFormatOf('config/app.yaml')
    expect(yaml).not.toBeNull()
    expect(configFormatOf('config/app.yml')).toBe(yaml)
  })

  it('gives distinct formats for YAML, JSON and dotenv files', () => {
    const formats = new Set([configFormatOf('a.yml'), configFormatOf('a.json'), configFormatOf('a.env')])
    expect(formats.size).toBe(3)
    expect(formats.has(null)).toBe(false)
  })

  it('recognizes a bare dotenv file name and a nested path', () => {
    expect(configFormatOf('.env')).toBe(configFormatOf('apps/server/.env'))
    expect(configFormatOf('.env')).not.toBeNull()
  })

  it('matches the extension only at the end of the path', () => {
    expect(configFormatOf('app.yml.bak')).toBeNull()
    expect(configFormatOf('package.json5')).toBeNull()
    expect(configFormatOf('.env.local')).toBeNull()
    expect(configFormatOf('yml')).toBeNull()
  })
})

describe('YAML format', () => {
  const yaml = formatOf('app.yml')

  it('reads like readMap', () => {
    expect(yaml.read('a: 1\n', 'the file')).toEqual({ a: 1 })
    expect(() => yaml.read('- a\n', 'app.yml')).toThrow('app.yml is not a YAML map')
  })

  it('changes a value keeping comments and the other keys', () => {
    expect(yaml.write('# header\na: 1 # keep\nb: 2\n', [{ path: ['b'], value: 3 }])).toBe('# header\na: 1 # keep\nb: 3\n')
  })

  it('removes a key', () => {
    expect(yaml.write('a: 1\nb: 2\n', [{ path: ['a'], value: undefined }])).toBe('b: 2\n')
  })

  it('removes a nested key', () => {
    expect(yaml.write('a:\n  b: 1\n  c: 2\n', [{ path: ['a', 'b'], value: undefined }])).toBe('a:\n  c: 2\n')
  })

  it('ignores the removal of a missing key', () => {
    expect(yaml.write('a: 1\n', [{ path: ['missing'], value: undefined }])).toBe('a: 1\n')
  })

  it('adds a key at the end of its map, creating the missing maps', () => {
    expect(yaml.write('a: 1\n', [{ path: ['b', 'c'], value: 'x' }])).toBe('a: 1\nb:\n  c: x\n')
  })

  it('writes a list and a map as values', () => {
    const result = yaml.write('a: 1\n', [{ path: ['a'], value: ['x', 'y'] }, { path: ['m'], value: { k: true } }])
    expect(yaml.read(result, 'the file')).toEqual({ a: ['x', 'y'], m: { k: true } })
  })

  it('writes onto an empty file', () => {
    expect(yaml.read(yaml.write('', [{ path: ['a', 'b'], value: 1 }]), 'the file')).toEqual({ a: { b: 1 } })
  })

  it('never folds long strings', () => {
    const long = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ')
    expect(yaml.write('a: 1\n', [{ path: ['a'], value: long }])).toBe(`a: ${long}\n`)
  })

  it('keeps the text unchanged without changes', () => {
    expect(yaml.write('a: 1 # note\n\nb:\n  - 1\n  - 2\n', [])).toBe('a: 1 # note\n\nb:\n  - 1\n  - 2\n')
  })

  it('keeps the layout of flow collections', () => {
    expect(yaml.write('a: 1\nb: [1, 2]\nc: {d: 1}\n', [])).toBe('a: 1\nb: [1, 2]\nc: {d: 1}\n')
    expect(yaml.write('a: 1\nb: [1, 2]\nc: {d: 1}\n', [{ path: ['a'], value: 2 }])).toBe('a: 2\nb: [1, 2]\nc: {d: 1}\n')
  })
})

describe('JSON format', () => {
  const json = formatOf('app.json')

  it('reads an object', () => {
    expect(json.read('{"a": 1, "b": {"c": [1, 2]}}', 'the file')).toEqual({ a: 1, b: { c: [1, 2] } })
  })

  it('reads an empty or blank text as an empty object', () => {
    expect(json.read('', 'the file')).toEqual({})
    expect(json.read('  \n\t', 'the file')).toEqual({})
  })

  it('names the file in the error for invalid JSON', () => {
    expect(() => json.read('{"a": ', 'app.json')).toThrow(/^app\.json is not valid JSON: /)
  })

  it('rejects a root that is not an object', () => {
    expect(() => json.read('[1]', 'app.json')).toThrow('app.json is not a JSON object')
    expect(() => json.read('null', 'app.json')).toThrow('app.json is not a JSON object')
    expect(() => json.read('"text"', 'app.json')).toThrow('app.json is not a JSON object')
  })

  it('changes a value keeping the key order', () => {
    expect(json.write('{\n  "a": 1,\n  "b": 2\n}\n', [{ path: ['a'], value: 3 }])).toBe('{\n  "a": 3,\n  "b": 2\n}\n')
  })

  it('removes a key', () => {
    expect(json.write('{\n  "a": 1,\n  "b": 2\n}', [{ path: ['a'], value: undefined }])).toBe('{\n  "b": 2\n}')
  })

  it('ignores the removal of a key whose parent is missing', () => {
    expect(json.write('{\n  "a": 1\n}', [{ path: ['x', 'y'], value: undefined }])).toBe('{\n  "a": 1\n}')
  })

  it('adds a key at the end of its object, creating the missing objects', () => {
    expect(json.write('{\n  "a": 1\n}', [{ path: ['b', 'c'], value: true }])).toBe('{\n  "a": 1,\n  "b": {\n    "c": true\n  }\n}')
  })

  it('replaces a non object parent when setting a nested key', () => {
    expect(json.read(json.write('{"a": 1}', [{ path: ['a', 'b'], value: 2 }]), 'the file')).toEqual({ a: { b: 2 } })
  })

  it('keeps a four space indent', () => {
    expect(json.write('{\n    "a": 1\n}\n', [{ path: ['b'], value: 2 }])).toBe('{\n    "a": 1,\n    "b": 2\n}\n')
  })

  it('keeps a tab indent', () => {
    expect(json.write('{\n\t"a": 1\n}\n', [{ path: ['a'], value: 2 }])).toBe('{\n\t"a": 2\n}\n')
  })

  it('uses a two space indent for a single line object', () => {
    expect(json.write('{"a": 1}', [{ path: ['a'], value: 2 }])).toBe('{\n  "a": 2\n}')
  })

  it('writes onto an empty file', () => {
    expect(json.write('', [{ path: ['a'], value: 'x' }])).toBe('{\n  "a": "x"\n}')
  })

  it('rejects an invalid base text', () => {
    expect(() => json.write('{', [])).toThrow(/^the file is not valid JSON: /)
  })
})

describe('dotenv format', () => {
  it('reads bare values', () => {
    expect(readDotenv('A=1\nB=hello\nC=\n')).toEqual({ A: '1', B: 'hello', C: '' })
  })

  it('reads keys with dots, dashes and underscores', () => {
    expect(readDotenv('_A.b-c_1=x\n')).toEqual({ '_A.b-c_1': 'x' })
  })

  it('reads an export prefix and leading whitespace', () => {
    expect(readDotenv('export A=1\n  B=2\n\texport  C=3\n')).toEqual({ A: '1', B: '2', C: '3' })
  })

  it('reads spaces around the equal sign', () => {
    expect(readDotenv('A = 1\nB=  2  \n')).toEqual({ A: '1', B: '2' })
  })

  it('skips comments, blank lines and invalid lines', () => {
    expect(readDotenv('# A=1\n\n1B=2\nnot a pair\nC=3\n')).toEqual({ C: '3' })
  })

  it('drops the trailing comment of a bare value', () => {
    expect(readDotenv('A=value # comment\nB=value\t# comment\n')).toEqual({ A: 'value', B: 'value' })
  })

  it('keeps a hash that is part of a bare value', () => {
    expect(readDotenv('A=abc#def\nB=#value\n')).toEqual({ A: 'abc#def', B: '#value' })
  })

  it('reads a value made only of a comment as empty', () => {
    expect(readDotenv('A= # comment\nB =\t# comment\nC=   #\n')).toEqual({ A: '', B: '', C: '' })
  })

  it('keeps the last value of a key declared several times', () => {
    expect(readDotenv('A=1\nA=2\n')).toEqual({ A: '2' })
  })

  it('reads a single-quoted value as is', () => {
    expect(readDotenv('A=\'a b # c \\n "d"\' # comment\n')).toEqual({ A: 'a b # c \\n "d"' })
  })

  it('reads an unterminated single-quoted value to the end of the line', () => {
    expect(readDotenv('A=\'open value\n')).toEqual({ A: 'open value' })
  })

  it('reads a double-quoted value with escapes', () => {
    expect(readDotenv('A="line1\\nline2 \\"quoted\\" back\\\\slash" # comment\n')).toEqual({ A: 'line1\nline2 "quoted" back\\slash' })
  })

  it('keeps the character after any other backslash', () => {
    expect(readDotenv('A="a\\tb\\$c"\n')).toEqual({ A: 'atb$c' })
  })

  it('reads an unterminated double-quoted value to the end of the line', () => {
    expect(readDotenv('A="open value\n')).toEqual({ A: 'open value' })
  })

  it('reads a hash inside quotes as part of the value', () => {
    expect(readDotenv('A="a # b"\n')).toEqual({ A: 'a # b' })
  })

  it('reads CRLF line endings', () => {
    expect(readDotenv('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' })
  })

  it('reads an empty file as an empty map', () => {
    expect(readDotenv('')).toEqual({})
  })

  it('changes a value in place keeping the prefix and other lines', () => {
    expect(writeDotenv('# header\n  export A=1 # old\nB=2\n', [{ path: ['A'], value: 'new' }])).toBe('# header\n  export A=new\nB=2\n')
  })

  it('removes a key line', () => {
    expect(writeDotenv('A=1\nB=2\nC=3\n', [{ path: ['B'], value: undefined }])).toBe('A=1\nC=3\n')
  })

  it('ignores the removal of a missing key', () => {
    expect(writeDotenv('A=1\n', [{ path: ['Z'], value: undefined }])).toBe('A=1\n')
  })

  it('changes the last line of a key declared several times', () => {
    const text = writeDotenv('A=1\nB=x\nA=2\n', [{ path: ['A'], value: '3' }])
    expect(text).toBe('A=1\nB=x\nA=3\n')
    expect(readDotenv(text)).toEqual({ A: '3', B: 'x' })
  })

  it('removes every line of a key declared several times', () => {
    expect(writeDotenv('A=1\nB=x\nA=2\n', [{ path: ['A'], value: undefined }])).toBe('B=x\n')
  })

  it('keeps CRLF line endings', () => {
    expect(writeDotenv('A=1\r\nB=2\r\n', [{ path: ['B'], value: '3' }, { path: ['C'], value: '4' }])).toBe('A=1\r\nB=3\r\nC=4\r\n')
    expect(writeDotenv('A=1\r\nB=2\r\n', [{ path: ['A'], value: undefined }])).toBe('B=2\r\n')
  })

  it('adds new keys before the final newline in the order of the changes', () => {
    expect(writeDotenv('A=1\n', [{ path: ['C'], value: '3' }, { path: ['B'], value: '2' }])).toBe('A=1\nC=3\nB=2\n')
  })

  it('adds new keys at the end of a file without a final newline', () => {
    expect(writeDotenv('A=1', [{ path: ['B'], value: '2' }])).toBe('A=1\nB=2')
  })

  it('adds keys to an empty file', () => {
    expect(writeDotenv('', [{ path: ['A'], value: '1' }])).toBe('A=1\n')
  })

  it('writes plain values bare', () => {
    expect(writeDotenv('', [{ path: ['A'], value: 'http://host:80/a,b+c=d@e-f_g.h' }, { path: ['B'], value: '' }])).toBe('A=http://host:80/a,b+c=d@e-f_g.h\nB=\n')
  })

  it('quotes and escapes values with other characters', () => {
    expect(writeDotenv('', [{ path: ['A'], value: 'a b "c" \\d\ne#f' }])).toBe('A="a b \\"c\\" \\\\d\\ne#f"\n')
  })

  it('writes values that are not strings as JSON', () => {
    expect(writeDotenv('', [{ path: ['A'], value: 3 }, { path: ['B'], value: true }, { path: ['C'], value: { k: 'v' } }])).toBe('A=3\nB=true\nC="{\\"k\\":\\"v\\"}"\n')
  })

  it('reads back what it writes', () => {
    const values = { PLAIN: 'abc', SPACED: 'a b', QUOTED: 'say "hi"', BACKSLASH: 'C:\\dir', MULTILINE: 'one\ntwo', HASH: 'x # y', SINGLE: 'it\'s' }
    const text = writeDotenv('', Object.entries(values).map(([key, value]) => ({ path: [key], value })))
    expect(readDotenv(text)).toEqual(values)
  })
})

describe('diffConfig', () => {
  const yaml = formatOf('app.yml')
  const json = formatOf('app.json')
  const dotenv = formatOf('.env')

  it('finds no difference between equal copies', () => {
    expect(diffConfig(yaml, 'a: 1\nb:\n  c: [1, 2]\n', 'b:\n  c: [1, 2]\na: 1 # comment\n')).toEqual([])
  })

  it('finds no difference between two empty copies', () => {
    expect(diffConfig(yaml, '', '')).toEqual([])
    expect(diffConfig(json, '', '{}')).toEqual([])
    expect(diffConfig(dotenv, '', '# only a comment\n')).toEqual([])
  })

  it('lists a changed scalar', () => {
    expect(diffConfig(yaml, 'a: 1\n', 'a: 2\n')).toEqual([{ path: ['a'], local: 1, remote: 2 }])
  })

  it('tells apart values of different types', () => {
    expect(diffConfig(yaml, 'a: 1\n', 'a: "1"\n')).toEqual([{ path: ['a'], local: 1, remote: '1' }])
  })

  it('lists a key added on one side with an absent value on the other', () => {
    expect(diffConfig(yaml, 'a: 1\n', 'a: 1\nb: 2\n')).toEqual([{ path: ['b'], local: undefined, remote: 2 }])
    expect(diffConfig(yaml, 'a: 1\nb: 2\n', 'a: 1\n')).toEqual([{ path: ['b'], local: 2, remote: undefined }])
  })

  it('tells apart a null value from an absent key', () => {
    expect(diffConfig(yaml, 'a: null\n', '')).toEqual([{ path: ['a'], local: null, remote: undefined }])
  })

  it('compares nested maps key by key', () => {
    expect(diffConfig(yaml, 'a:\n  b: 1\n  c: 2\n  d:\n    e: x\n', 'a:\n  b: 1\n  c: 3\n  d:\n    e: y\n')).toEqual([
      { path: ['a', 'c'], local: 2, remote: 3 },
      { path: ['a', 'd', 'e'], local: 'x', remote: 'y' }
    ])
  })

  it('lists a nested key added on one side', () => {
    expect(diffConfig(yaml, 'a:\n  b: 1\n', 'a:\n  b: 1\n  c: 2\n')).toEqual([{ path: ['a', 'c'], local: undefined, remote: 2 }])
  })

  it('compares lists as a whole', () => {
    expect(diffConfig(yaml, 'a: [1, 2, 3]\n', 'a: [1, 2, 4]\n')).toEqual([{ path: ['a'], local: [1, 2, 3], remote: [1, 2, 4] }])
  })

  it('compares lists of maps as a whole', () => {
    expect(diffConfig(yaml, 'a:\n  - k: 1\n', 'a:\n  - k: 2\n')).toEqual([{ path: ['a'], local: [{ k: 1 }], remote: [{ k: 2 }] }])
  })

  it('finds no difference between equal lists of maps', () => {
    expect(diffConfig(yaml, 'a:\n  - k: 1\n    l: [x]\n', 'a: [{ k: 1, l: [x] }]\n')).toEqual([])
  })

  it('compares a map with a scalar or a list as a whole', () => {
    expect(diffConfig(yaml, 'a:\n  b: 1\n', 'a: text\n')).toEqual([{ path: ['a'], local: { b: 1 }, remote: 'text' }])
    expect(diffConfig(yaml, 'a: [1]\n', 'a:\n  b: 1\n')).toEqual([{ path: ['a'], local: [1], remote: { b: 1 } }])
  })

  it('lists a whole map added on one side', () => {
    expect(diffConfig(yaml, '', 'a:\n  b: 1\n')).toEqual([{ path: ['a'], local: undefined, remote: { b: 1 } }])
  })

  it('lists the local keys first, then the keys only in the CDN copy', () => {
    const differences = diffConfig(yaml, 'b: 1\nc: 1\na: 1\n', 'z: 2\na: 2\nb: 2\ny: 2\n')
    expect(differences.map(difference => difference.path.join('.'))).toEqual(['b', 'c', 'a', 'z', 'y'])
  })

  it('keeps dotted keys as a single path element', () => {
    expect(diffConfig(yaml, '"a.b": 1\n', '"a.b": 2\n')).toEqual([{ path: ['a.b'], local: 1, remote: 2 }])
  })

  it('compares JSON copies', () => {
    expect(diffConfig(json, '{"a": {"b": 1}, "l": [1]}', '{"a": {"b": 2}, "l": [1], "n": null}')).toEqual([
      { path: ['a', 'b'], local: 1, remote: 2 },
      { path: ['n'], local: undefined, remote: null }
    ])
  })

  it('compares dotenv copies as flat strings', () => {
    expect(diffConfig(dotenv, 'A=1\nB="x y"\n', 'export A=1\nB=\'x y\'\nC=2\n')).toEqual([{ path: ['C'], local: undefined, remote: '2' }])
    expect(diffConfig(dotenv, 'A=1\n', 'A=2\n')).toEqual([{ path: ['A'], local: '1', remote: '2' }])
  })

  it('names the local copy in the error for an invalid local copy', () => {
    expect(() => diffConfig(yaml, 'a: [\n', 'a: 1\n')).toThrow(/^the local copy is not valid YAML: /)
    expect(() => diffConfig(json, '{', '{}')).toThrow(/^the local copy is not valid JSON: /)
    expect(() => diffConfig(yaml, '- a\n', 'a: 1\n')).toThrow('the local copy is not a YAML map')
  })

  it('names the CDN copy in the error for an invalid CDN copy', () => {
    expect(() => diffConfig(yaml, 'a: 1\n', 'a: [\n')).toThrow(/^the CDN copy is not valid YAML: /)
    expect(() => diffConfig(json, '{}', '[]')).toThrow('the CDN copy is not a JSON object')
  })
})

describe('mergeConfig', () => {
  const yaml = formatOf('app.yml')
  const local = '# local settings\na: 1 # first\nb:\n  c: 1\n  d:\n    - 1\nonly_local: x\n'
  const remote = 'a: 2\nb:\n  c: 1\n  d:\n    - 2\nonly_remote: y\n'

  it('keeps the base copy unchanged without choices', () => {
    expect(merge('app.yml', local, remote, 'local', [])).toBe(local)
    expect(merge('app.yml', local, remote, 'remote', [])).toBe(remote)
  })

  it('keeps the base copy unchanged when every choice is the base side', () => {
    const choices: KeyChoice[] = [{ path: ['a'], side: 'local' }, { path: ['only_remote'], side: 'local' }]
    expect(merge('app.yml', local, remote, 'local', choices)).toBe(local)
  })

  it('applies CDN values onto the local copy keeping its comments', () => {
    const merged = merge('app.yml', local, remote, 'local', [{ path: ['a'], side: 'remote' }, { path: ['b', 'd'], side: 'remote' }])
    expect(merged).toBe('# local settings\na: 2 # first\nb:\n  c: 1\n  d:\n    - 2\nonly_local: x\n')
  })

  it('adds a key chosen from the other copy', () => {
    const merged = merge('app.yml', local, remote, 'local', [{ path: ['only_remote'], side: 'remote' }])
    expect(readMap(merged, 'the file')).toEqual({ a: 1, b: { c: 1, d: [1] }, only_local: 'x', only_remote: 'y' })
  })

  it('removes a key absent from the chosen copy', () => {
    const merged = merge('app.yml', local, remote, 'local', [{ path: ['only_local'], side: 'remote' }])
    expect(readMap(merged, 'the file')).toEqual({ a: 1, b: { c: 1, d: [1] } })
  })

  it('applies local values onto the CDN copy', () => {
    const merged = merge('app.yml', local, remote, 'remote', [{ path: ['a'], side: 'local' }, { path: ['only_local'], side: 'local' }, { path: ['only_remote'], side: 'local' }])
    expect(readMap(merged, 'the file')).toEqual({ a: 1, b: { c: 1, d: [2] }, only_local: 'x' })
  })

  it('gives a copy with no difference left when every key takes the other side', () => {
    const differences = diffConfig(yaml, local, remote)
    const choices = differences.map(difference => ({ path: difference.path, side: 'remote' as const }))
    const merged = mergeConfig(yaml, local, 'local', differences, choices)
    expect(diffConfig(yaml, merged, remote)).toEqual([])
  })

  it('replaces a whole map with a scalar and back', () => {
    expect(merge('app.yml', 'a:\n  b: 1\n', 'a: text\n', 'local', [{ path: ['a'], side: 'remote' }])).toBe('a: text\n')
    expect(readMap(merge('app.yml', 'a:\n  b: 1\n', 'a: text\n', 'remote', [{ path: ['a'], side: 'local' }]), 'the file')).toEqual({ a: { b: 1 } })
  })

  it('ignores choices for keys that do not differ', () => {
    expect(merge('app.yml', 'a: 1\nb: 1\n', 'a: 1\nb: 2\n', 'local', [{ path: ['a'], side: 'remote' }, { path: ['zzz'], side: 'remote' }])).toBe('a: 1\nb: 1\n')
  })

  it('matches choices on the whole path', () => {
    const merged = merge('app.yml', '"a.b": 1\na:\n  b: 1\n', '"a.b": 2\na:\n  b: 2\n', 'local', [{ path: ['a', 'b'], side: 'remote' }])
    expect(readMap(merged, 'the file')).toEqual({ 'a.b': 1, 'a': { b: 2 } })
  })

  it('merges JSON copies keeping the base indent and key order', () => {
    const merged = merge('app.json', '{\n    "a": 1,\n    "b": 1\n}\n', '{\n  "b": 2,\n  "c": 3\n}', 'local', [{ path: ['a'], side: 'remote' }, { path: ['b'], side: 'remote' }, { path: ['c'], side: 'remote' }])
    expect(merged).toBe('{\n    "b": 2,\n    "c": 3\n}\n')
  })

  it('merges nested JSON keys', () => {
    const merged = merge('app.json', '{"a": {"b": 1, "c": 1}}', '{"a": {"b": 2, "c": 2}}', 'remote', [{ path: ['a', 'c'], side: 'local' }])
    expect(JSON.parse(merged)).toEqual({ a: { b: 2, c: 1 } })
  })

  it('merges dotenv copies keeping comments and prefixes', () => {
    const merged = merge('.env', '# keep\nexport A=1\nB=1\nC=1\n', 'A="new value"\nB=1\nD=4\n', 'local', [{ path: ['A'], side: 'remote' }, { path: ['C'], side: 'remote' }, { path: ['D'], side: 'remote' }])
    expect(merged).toBe('# keep\nexport A="new value"\nB=1\nD=4\n')
  })

  it('leaves no difference on a dotenv key declared several times once it takes the other side', () => {
    const dotenv = formatOf('.env')
    const changed = merge('.env', 'A=1\nA=2\n', 'A=3\n', 'local', [{ path: ['A'], side: 'remote' }])
    const removed = merge('.env', 'A=1\nA=2\nB=1\n', 'B=1\n', 'local', [{ path: ['A'], side: 'remote' }])
    expect(changed).toBe('A=1\nA=3\n')
    expect(diffConfig(dotenv, changed, 'A=3\n')).toEqual([])
    expect(removed).toBe('B=1\n')
    expect(diffConfig(dotenv, removed, 'B=1\n')).toEqual([])
  })

  it('keeps the dotenv base copy when nothing takes the other side', () => {
    expect(merge('.env', 'A=1\nB=x # note\n', 'A=2\n', 'local', [])).toBe('A=1\nB=x # note\n')
  })

  it('applies differences built by hand', () => {
    const differences: KeyDifference[] = [{ path: ['a'], local: 1, remote: 5 }]
    expect(mergeConfig(yaml, 'a: 1\n', 'local', differences, [{ path: ['a'], side: 'remote' }])).toBe('a: 5\n')
  })
})

describe('countChoices', () => {
  const differences: KeyDifference[] = [
    { path: ['a'], local: 1, remote: 2 },
    { path: ['b', 'c'], local: 1, remote: undefined },
    { path: ['d'], local: undefined, remote: 1 }
  ]

  it('counts every key on the base side without choices', () => {
    expect(countChoices(differences, [], 'local')).toEqual({ local: 3, remote: 0 })
    expect(countChoices(differences, [], 'remote')).toEqual({ local: 0, remote: 3 })
  })

  it('counts the chosen side of each key', () => {
    const choices: KeyChoice[] = [{ path: ['a'], side: 'remote' }, { path: ['b', 'c'], side: 'local' }]
    expect(countChoices(differences, choices, 'local')).toEqual({ local: 2, remote: 1 })
    expect(countChoices(differences, choices, 'remote')).toEqual({ local: 1, remote: 2 })
  })

  it('ignores choices for keys that do not differ', () => {
    expect(countChoices(differences, [{ path: ['zzz'], side: 'remote' }, { path: ['b'], side: 'remote' }], 'local')).toEqual({ local: 3, remote: 0 })
  })

  it('gives zero counts without differences', () => {
    expect(countChoices([], [{ path: ['a'], side: 'remote' }], 'local')).toEqual({ local: 0, remote: 0 })
  })

  it('agrees with the keys mergeConfig changes', () => {
    const yaml = formatOf('app.yml')
    const local = 'a: 1\nb: 1\nc: 1\n'
    const remote = 'a: 2\nb: 2\nc: 2\n'
    const found = diffConfig(yaml, local, remote)
    const choices: KeyChoice[] = [{ path: ['a'], side: 'remote' }, { path: ['c'], side: 'remote' }]
    const merged = mergeConfig(yaml, local, 'local', found, choices)
    expect(countChoices(found, choices, 'local')).toEqual({ local: 1, remote: 2 })
    expect(diffConfig(yaml, merged, remote)).toHaveLength(1)
  })
})
