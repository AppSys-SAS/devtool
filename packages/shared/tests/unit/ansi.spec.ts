import { describe, expect, it } from 'vitest'
import { stripAnsi } from '../../src/ansi.js'

describe('stripAnsi', () => {
  it('removes color sequences', () => {
    expect(stripAnsi('\x1b[31merror\x1b[0m')).toBe('error')
  })

  it('removes sequences with several parameters', () => {
    expect(stripAnsi('\x1b[1;32;48;5;236mready\x1b[39;49m')).toBe('ready')
  })

  it('removes sequences without parameters', () => {
    expect(stripAnsi('\x1b[mplain\x1b[K')).toBe('plain')
  })

  it('removes cursor and erase sequences', () => {
    expect(stripAnsi('\x1b[2K\x1b[1A\x1b[1Gline\x1b[0J')).toBe('line')
  })

  it.each([
    { name: 'a hidden cursor', sequence: '\x1b[?25l' },
    { name: 'a device attributes request', sequence: '\x1b[>0c' },
    { name: 'a key modifier option', sequence: '\x1b[>4;1m' },
    { name: 'a cursor shape with an intermediate byte', sequence: '\x1b[2 q' },
    { name: 'a soft reset with an intermediate byte', sequence: '\x1b[!p' }
  ])('removes the CSI sequence of $name', ({ sequence }) => {
    expect(stripAnsi(`before${sequence}after`)).toBe('beforeafter')
  })

  it('removes operating system commands terminated by BEL', () => {
    expect(stripAnsi('\x1b]0;window title\x07body')).toBe('body')
  })

  it('removes operating system commands terminated by ST', () => {
    expect(stripAnsi('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\')).toBe('link')
  })

  it.each([
    { name: 'a device control string', sequence: '\x1bP+q544e\x1b\\' },
    { name: 'a device control string with parameters', sequence: '\x1bP1$r0m\x1b\\' },
    { name: 'a start of string', sequence: '\x1bXpayload\x1b\\' },
    { name: 'a privacy message', sequence: '\x1b^payload\x1b\\' },
    { name: 'an application program command', sequence: '\x1b_Gi=1\x1b\\' },
    { name: 'an empty application program command', sequence: '\x1b_\x1b\\' }
  ])('removes $name with its payload', ({ sequence }) => {
    expect(stripAnsi(`before${sequence}after`)).toBe('beforeafter')
  })

  it('removes each string up to its own terminator', () => {
    expect(stripAnsi('\x1bP+q544e\x1b\\a\x1b_Gi=1\x1b\\b')).toBe('ab')
  })

  it.each([
    { name: 'the ASCII charset in G0', sequence: '\x1b(B' },
    { name: 'the line drawing charset in G0', sequence: '\x1b(0' },
    { name: 'the line drawing charset in G1', sequence: '\x1b)0' },
    { name: 'a charset in G2', sequence: '\x1b*B' },
    { name: 'a charset in G3', sequence: '\x1b+B' },
    { name: 'a multi-byte charset', sequence: '\x1b$(B' },
    { name: 'a UTF-8 selection', sequence: '\x1b%G' },
    { name: 'a screen alignment test', sequence: '\x1b#8' }
  ])('removes the designation of $name', ({ sequence }) => {
    expect(stripAnsi(`before${sequence}after`)).toBe('beforeafter')
  })

  it('removes a charset designation before text', () => {
    expect(stripAnsi('\x1b(Btext')).toBe('text')
  })

  it.each([
    { name: 'a cursor save', sequence: '\x1b7' },
    { name: 'a cursor restore', sequence: '\x1b8' },
    { name: 'an application keypad', sequence: '\x1b=' },
    { name: 'a normal keypad', sequence: '\x1b>' },
    { name: 'a full reset', sequence: '\x1bc' },
    { name: 'a reverse index', sequence: '\x1bM' },
    { name: 'an index', sequence: '\x1bD' },
    { name: 'a next line', sequence: '\x1bE' },
    { name: 'a tab set', sequence: '\x1bH' },
    { name: 'a string terminator', sequence: '\x1b\\' },
    { name: 'the lowest final byte', sequence: '\x1b@' },
    { name: 'the highest final byte', sequence: '\x1b~' }
  ])('removes the two-character sequence of $name', ({ sequence }) => {
    expect(stripAnsi(`before${sequence}after`)).toBe('beforeafter')
  })

  it('removes consecutive sequences of every kind', () => {
    expect(stripAnsi('\x1b7\x1b(B\x1b[m\x1b]0;title\x07\x1b_Gi=1\x1b\\ok\x1b8')).toBe('ok')
  })

  it('keeps the text between sequences intact', () => {
    expect(stripAnsi('\x1b[32m✔\x1b[0m done\n\t\x1b[33mwarn\x1b[0m: é')).toBe('✔ done\n\twarn: é')
  })

  it('returns text without escape sequences unchanged', () => {
    expect(stripAnsi('no colors [31m here (B ]0;x')).toBe('no colors [31m here (B ]0;x')
  })

  it('returns an empty string for an empty string', () => {
    expect(stripAnsi('')).toBe('')
  })

  it('gives the same result on repeated calls', () => {
    const text = '\x1b[31mred\x1b[0m'

    expect(stripAnsi(text)).toBe('red')
    expect(stripAnsi(text)).toBe('red')
  })
})
