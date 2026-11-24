import { describe, expect, it, vi } from 'vitest'
import { commandInputs, defaultCommandInputs, expandCommandArgs, missingCommandInputs, replaceVariables, splitCommandText } from '../../src/command-args.js'
import type { CommandArg, CommandInput, CommandInputValue } from '../../src/types.js'

/**
 * Builds an input with plain settings, overridden by the given fields.
 * @param fields - The name, kind and any other setting of the input.
 * @returns The input.
 */
function input (fields: Pick<CommandInput, 'name' | 'kind'> & Partial<CommandInput>): CommandInput {
  return { choices: [], display: 'buttons', optional: false, default: null, ...fields }
}

/**
 * Builds a choice input offering the given values, each labelled by itself.
 * @param name - The name of the input.
 * @param values - The values it offers.
 * @param fields - Any other setting of the input.
 * @returns The input.
 */
function choice (name: string, values: string[], fields: Partial<CommandInput> = {}): CommandInput {
  return input({ name, kind: 'choice', choices: values.map(value => ({ label: value, value })), ...fields })
}

const environment = choice('environment', ['dev', 'prod'])
const force = input({ name: '--force', kind: 'flag' })
const extra = input({ name: 'extra', kind: 'text', default: '--verbose' })
const args: CommandArg[] = ['deploy', environment, force, extra]

describe('splitCommandText', () => {
  it('splits on spaces and keeps quoted words together', () => {
    expect(splitCommandText('run "a b" \'c d\'  e')).toEqual(['run', 'a b', 'c d', 'e'])
  })

  it('gives nothing for an empty or blank line', () => {
    expect(splitCommandText('')).toEqual([])
    expect(splitCommandText('   ')).toEqual([])
  })

  it('splits on tabs and line breaks and ignores surrounding blanks', () => {
    expect(splitCommandText('\t a\tb\nc \r\n')).toEqual(['a', 'b', 'c'])
  })

  it('keeps an empty quoted word as an empty argument', () => {
    expect(splitCommandText('a "" \'\' b')).toEqual(['a', '', '', 'b'])
  })

  it('keeps the other kind of quote inside a quoted word', () => {
    expect(splitCommandText('"it\'s" \'say "hi"\'')).toEqual(['it\'s', 'say "hi"'])
  })

  it('keeps blanks and line breaks inside a quoted word', () => {
    expect(splitCommandText('"a  b\nc"')).toEqual(['a  b\nc'])
  })

  it('splits adjacent quoted words', () => {
    expect(splitCommandText('"a""b"\'c\'')).toEqual(['a', 'b', 'c'])
  })

  it('keeps an unclosed quote as part of a plain word', () => {
    expect(splitCommandText('"a b')).toEqual(['"a', 'b'])
    expect(splitCommandText('it\'s')).toEqual(['it\'s'])
  })
})

describe('commandInputs', () => {
  it('lists the inputs in order, without the fixed arguments', () => {
    expect(commandInputs(args)).toEqual([environment, force, extra])
  })

  it('gives the inputs themselves', () => {
    expect(commandInputs(args)[0]).toBe(environment)
  })

  it('gives nothing without arguments or without inputs', () => {
    expect(commandInputs([])).toEqual([])
    expect(commandInputs(['run', 'build'])).toEqual([])
  })
})

describe('defaultCommandInputs', () => {
  it('gives the default value of each input in order, empty when it declares none', () => {
    expect(defaultCommandInputs(args)).toEqual(['', '', '--verbose'])
  })

  it('keeps boolean and empty defaults as declared', () => {
    const flags: CommandArg[] = [
      input({ name: '--on', kind: 'flag', default: true }),
      input({ name: '--off', kind: 'flag', default: false }),
      input({ name: 'empty', kind: 'text', default: '' })
    ]

    expect(defaultCommandInputs(flags)).toEqual([true, false, ''])
  })

  it('gives the default of a choice', () => {
    expect(defaultCommandInputs([choice('environment', ['dev', 'prod'], { default: 'prod' })])).toEqual(['prod'])
  })

  it('gives nothing without inputs', () => {
    expect(defaultCommandInputs([])).toEqual([])
    expect(defaultCommandInputs(['run'])).toEqual([])
  })
})

describe('expandCommandArgs', () => {
  it('replaces each input by what was typed for it', () => {
    expect(expandCommandArgs(args, ['prod', true, '--dry-run "a b"'])).toEqual(['deploy', 'prod', '--force', '--dry-run', 'a b'])
  })

  it('drops unset flags, unknown choices and missing values', () => {
    expect(expandCommandArgs(args, ['staging', false])).toEqual(['deploy'])
  })

  it('gives nothing without arguments', () => {
    expect(expandCommandArgs([], ['ignored'])).toEqual([])
  })

  it('keeps fixed arguments whole and ignores values when there are no inputs', () => {
    expect(expandCommandArgs(['echo', 'a b', ''], ['ignored', true])).toEqual(['echo', 'a b', ''])
  })

  it('gives the name of a flag only when it is set to true', () => {
    const values: CommandInputValue[][] = [[true], [false], ['true'], ['--force'], []]

    expect(values.map(value => expandCommandArgs([force], value))).toEqual([['--force'], [], [], [], []])
  })

  it('splits a text into its words, quotes kept together', () => {
    expect(expandCommandArgs([extra], ['  -m "fix it"  --all '])).toEqual(['-m', 'fix it', '--all'])
  })

  it('gives nothing for an empty, blank, boolean or missing text', () => {
    const values: CommandInputValue[][] = [[''], ['   '], [true], [false], []]

    expect(values.map(value => expandCommandArgs([extra], value))).toEqual([[], [], [], [], []])
  })

  it('gives a valid choice whole, even with blanks', () => {
    const message = choice('message', ['hello world'])

    expect(expandCommandArgs([message], ['hello world'])).toEqual(['hello world'])
  })

  it('gives nothing for a choice that is not offered, boolean or missing', () => {
    const values: CommandInputValue[][] = [['staging'], ['Dev'], ['dev '], [''], [true], []]

    expect(values.map(value => expandCommandArgs([environment], value))).toEqual([[], [], [], [], [], []])
  })

  it('matches a choice by its value, not its label', () => {
    const labelled = input({ name: 'environment', kind: 'choice', choices: [{ label: 'Production', value: 'prod' }] })

    expect(expandCommandArgs([labelled], ['Production'])).toEqual([])
    expect(expandCommandArgs([labelled], ['prod'])).toEqual(['prod'])
  })

  it('gives nothing for a choice without values', () => {
    expect(expandCommandArgs([choice('empty', [])], ['anything'])).toEqual([])
  })

  it('drops an optional choice left out and keeps it when picked', () => {
    const region = choice('region', ['eu', 'us'], { optional: true })

    expect(expandCommandArgs(['run', region], [''])).toEqual(['run'])
    expect(expandCommandArgs(['run', region], ['eu'])).toEqual(['run', 'eu'])
  })

  it('reads the values by position among the inputs, fixed arguments skipped', () => {
    const mixed: CommandArg[] = ['a', environment, 'b', 'c', force, 'd', extra, 'e']

    expect(expandCommandArgs(mixed, ['dev', true, 'x y'])).toEqual(['a', 'dev', 'b', 'c', '--force', 'd', 'x', 'y', 'e'])
  })

  it('keeps the positions of the later inputs when an earlier one gives nothing', () => {
    expect(expandCommandArgs(args, ['staging', true, 'x'])).toEqual(['deploy', '--force', 'x'])
  })

  it('ignores values beyond the inputs', () => {
    expect(expandCommandArgs(['run', force], [true, 'extra', false])).toEqual(['run', '--force'])
  })

  it('starts from the first value on every call and leaves the values untouched', () => {
    const values: CommandInputValue[] = ['dev', true, 'x']

    expect(expandCommandArgs(args, values)).toEqual(['deploy', 'dev', '--force', 'x'])
    expect(expandCommandArgs(args, values)).toEqual(['deploy', 'dev', '--force', 'x'])
    expect(values).toEqual(['dev', true, 'x'])
  })

  it('expands the same input listed twice from two values', () => {
    expect(expandCommandArgs([force, force], [true, false])).toEqual(['--force'])
  })
})

describe('missingCommandInputs', () => {
  it('lists the required choices without a valid value', () => {
    expect(missingCommandInputs(args, ['staging', false, ''])).toEqual(['environment'])
    expect(missingCommandInputs(args, ['dev', false, ''])).toEqual([])
  })

  it('ignores optional choices', () => {
    const optional: CommandArg[] = [choice('region', ['eu'], { optional: true })]

    expect(missingCommandInputs(optional, [])).toEqual([])
    expect(missingCommandInputs(optional, ['us'])).toEqual([])
  })

  it('never lists flags or texts', () => {
    const others: CommandArg[] = [force, extra, input({ name: 'required', kind: 'text' })]

    expect(missingCommandInputs(others, [])).toEqual([])
    expect(missingCommandInputs(others, [false, '', ''])).toEqual([])
  })

  it('lists every missing choice in order', () => {
    const choices: CommandArg[] = [choice('first', ['a']), choice('second', ['b']), choice('third', ['c'])]

    expect(missingCommandInputs(choices, [])).toEqual(['first', 'second', 'third'])
    expect(missingCommandInputs(choices, ['x', 'b', true])).toEqual(['first', 'third'])
  })

  it('reads the values by position among the inputs, fixed arguments skipped', () => {
    const mixed: CommandArg[] = ['a', force, 'b', environment, 'c']

    expect(missingCommandInputs(mixed, [true, 'prod'])).toEqual([])
    expect(missingCommandInputs(mixed, ['prod', true])).toEqual(['environment'])
  })

  it('lists a choice given a boolean, a label or nothing', () => {
    const labelled = input({ name: 'environment', kind: 'choice', choices: [{ label: 'Production', value: 'prod' }] })

    expect(missingCommandInputs([labelled], [true])).toEqual(['environment'])
    expect(missingCommandInputs([labelled], ['Production'])).toEqual(['environment'])
    expect(missingCommandInputs([labelled], [])).toEqual(['environment'])
  })

  it('always lists a required choice without values', () => {
    expect(missingCommandInputs([choice('empty', [])], ['anything'])).toEqual(['empty'])
  })

  it('gives nothing without arguments or without inputs', () => {
    expect(missingCommandInputs([], [])).toEqual([])
    expect(missingCommandInputs(['run'], ['x'])).toEqual([])
  })
})

describe('replaceVariables', () => {
  it('replaces known variables and leaves unknown ones as written', () => {
    expect(replaceVariables('%{ADT:BRANCH} on %{ADT:REPO} by %{ADT:OTHER}', { BRANCH: 'main', REPO: 'devtool' }))
      .toBe('main on devtool by %{ADT:OTHER}')
  })

  it('encodes the values and never reads them again', () => {
    expect(replaceVariables('?q=%{ADT:QUERY}', { QUERY: 'a b&%{ADT:QUERY}' }, encodeURIComponent))
      .toBe('?q=a%20b%26%25%7BADT%3AQUERY%7D')
  })

  it('gives a text without variables unchanged', () => {
    expect(replaceVariables('', { A: 'x' })).toBe('')
    expect(replaceVariables('plain $HOME text', { HOME: 'x' })).toBe('plain $HOME text')
  })

  it('replaces every occurrence, including adjacent ones', () => {
    expect(replaceVariables('%{ADT:A}%{ADT:B}-%{ADT:A}', { A: '1', B: '2' })).toBe('12-1')
  })

  it('accepts names made of capitals and underscores', () => {
    expect(replaceVariables('%{ADT:PR_BASE}..%{ADT:_}', { PR_BASE: 'main', _: 'x' })).toBe('main..x')
  })

  it('leaves malformed variables as written', () => {
    const text = '%{ADT:branch} %{ADT:V1} %{ADT:} {ADT:A} %{adt:A} %{ADT:A %{ADT: A}'

    expect(replaceVariables(text, { A: 'x', branch: 'y', V1: 'z' })).toBe(text)
  })

  it('replaces a variable whose value is empty', () => {
    expect(replaceVariables('[%{ADT:EMPTY}]', { EMPTY: '' })).toBe('[]')
  })

  it('never expands a value naming another variable', () => {
    expect(replaceVariables('%{ADT:A} %{ADT:B}', { A: '%{ADT:B}', B: '%{ADT:A}' })).toBe('%{ADT:B} %{ADT:A}')
  })

  it('writes values containing replacement patterns literally', () => {
    expect(replaceVariables('%{ADT:A}', { A: '$&$1$$' })).toBe('$&$1$$')
  })

  it('ignores inherited values', () => {
    const values = Object.create({ INHERITED: 'x' }) as Record<string, string>

    expect(replaceVariables('%{ADT:INHERITED}', values)).toBe('%{ADT:INHERITED}')
  })

  it('encodes each known value once and never the unknown variables', () => {
    const encode = vi.fn((value: string) => `<${value}>`)

    expect(replaceVariables('%{ADT:A} %{ADT:UNKNOWN} %{ADT:A}', { A: 'a' }, encode)).toBe('<a> %{ADT:UNKNOWN} <a>')
    expect(encode.mock.calls).toEqual([['a'], ['a']])
  })

  it('encodes the value, not the text around it', () => {
    expect(replaceVariables('a b/%{ADT:PATH}', { PATH: 'c d' }, encodeURIComponent)).toBe('a b/c%20d')
  })
})
