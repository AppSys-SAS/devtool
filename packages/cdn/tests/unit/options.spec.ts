import { describe, expect, it } from 'vitest'
import { readCdnOptions } from '../../src/options.js'

/**
 * Builds a complete `cdn` section whose `openid` fields can be overridden.
 *
 * @param openid - Fields merged over the default `openid` object.
 * @returns A raw `cdn` section.
 */
function section (openid: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'https://cdn.example.dev',
    openid: { issuer: 'https://auth.example.dev', clientId: 'devtool', ...openid }
  }
}

describe('readCdnOptions', () => {
  it('reads a complete section and strips trailing slashes', () => {
    expect(readCdnOptions({
      url: 'https://cdn.example.dev//',
      openid: { issuer: 'https://auth.example.dev/', clientId: 'devtool', name: ' My SSO ', callbackPort: 7000 }
    })).toEqual({
      url: 'https://cdn.example.dev',
      issuer: 'https://auth.example.dev',
      issuerName: 'My SSO',
      clientId: 'devtool',
      callbackPort: 7000
    })
  })

  it('falls back to the default callback port and no issuer name', () => {
    const options = readCdnOptions({ url: 'https://cdn.example.dev', openid: { issuer: 'https://auth.example.dev', clientId: 'devtool', name: ' ', callbackPort: -1 } })

    expect(options?.callbackPort).toBe(6732)
    expect(options?.issuerName).toBeNull()
    expect(readCdnOptions({ url: 'u', openid: { issuer: 'i', clientId: 'c' } })?.callbackPort).toBe(6732)
  })

  it('gives null for a missing or incomplete section', () => {
    expect(readCdnOptions(undefined)).toBeNull()
    expect(readCdnOptions('https://cdn.example.dev')).toBeNull()
    expect(readCdnOptions({ url: 'https://cdn.example.dev' })).toBeNull()
    expect(readCdnOptions({ url: 'https://cdn.example.dev', openid: { issuer: 'https://auth.example.dev' } })).toBeNull()
  })

  it('reads a minimal section with defaults', () => {
    expect(readCdnOptions(section())).toEqual({
      url: 'https://cdn.example.dev',
      issuer: 'https://auth.example.dev',
      issuerName: null,
      clientId: 'devtool',
      callbackPort: 6732
    })
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'https://cdn.example.dev'],
    ['a number', 42],
    ['a boolean', true],
    ['a function', () => section()],
    ['an empty array', []],
    ['an array of sections', [section()]],
    ['an empty object', {}]
  ])('gives null when the section is %s', (_label, value) => {
    expect(readCdnOptions(value)).toBeNull()
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a string', 'https://auth.example.dev'],
    ['a number', 1],
    ['an array', ['https://auth.example.dev', 'devtool']],
    ['an empty object', {}]
  ])('gives null when openid is %s', (_label, openid) => {
    expect(readCdnOptions({ url: 'https://cdn.example.dev', openid })).toBeNull()
  })

  it('ignores issuer and clientId given outside openid', () => {
    expect(readCdnOptions({ url: 'https://cdn.example.dev', issuer: 'https://auth.example.dev', clientId: 'devtool' })).toBeNull()
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a number', 1],
    ['a boolean', true],
    ['an array', ['https://cdn.example.dev']],
    ['an object', { href: 'https://cdn.example.dev' }],
    ['empty', ''],
    ['blank', ' \t ']
  ])('gives null when url is %s', (_label, url) => {
    expect(readCdnOptions({ ...section(), url })).toBeNull()
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a number', 1],
    ['an array', ['https://auth.example.dev']],
    ['an object', { url: 'https://auth.example.dev' }],
    ['empty', ''],
    ['blank', ' \t ']
  ])('gives null when issuer is %s', (_label, issuer) => {
    expect(readCdnOptions(section({ issuer }))).toBeNull()
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a number', 123],
    ['a boolean', false],
    ['an array', ['devtool']],
    ['empty', ''],
    ['blank', ' \t ']
  ])('gives null when clientId is %s', (_label, clientId) => {
    expect(readCdnOptions(section({ clientId }))).toBeNull()
  })

  it.each([
    ['https://cdn.example.dev', 'https://cdn.example.dev'],
    ['https://cdn.example.dev/', 'https://cdn.example.dev'],
    ['https://cdn.example.dev///', 'https://cdn.example.dev'],
    ['https://cdn.example.dev/assets/', 'https://cdn.example.dev/assets'],
    ['https://cdn.example.dev//assets//', 'https://cdn.example.dev//assets']
  ])('normalizes the url %s to %s', (url, expected) => {
    expect(readCdnOptions({ ...section(), url })?.url).toBe(expected)
  })

  it.each([
    ['https://auth.example.dev', 'https://auth.example.dev'],
    ['https://auth.example.dev/', 'https://auth.example.dev'],
    ['https://auth.example.dev/realms/dev//', 'https://auth.example.dev/realms/dev']
  ])('normalizes the issuer %s to %s', (issuer, expected) => {
    expect(readCdnOptions(section({ issuer }))?.issuer).toBe(expected)
  })

  it('keeps the clientId untouched', () => {
    expect(readCdnOptions(section({ clientId: ' devtool/ ' }))?.clientId).toBe(' devtool/ ')
  })

  it.each([
    ['missing', undefined, null],
    ['null', null, null],
    ['empty', '', null],
    ['blank', ' \t\n ', null],
    ['a number', 42, null],
    ['a boolean', true, null],
    ['an array', ['My SSO'], null],
    ['an object', { label: 'My SSO' }, null],
    ['plain', 'My SSO', 'My SSO'],
    ['padded', '\t My SSO \n', 'My SSO'],
    ['spaced inside', ' My  Company  SSO ', 'My  Company  SSO']
  ])('reads the issuer name when it is %s', (_label, name, expected) => {
    expect(readCdnOptions(section({ name }))?.issuerName).toBe(expected)
  })

  it.each([
    ['an integer', 7000, 7000],
    ['one', 1, 1],
    ['a numeric string', '7000', 7000],
    ['a padded numeric string', ' 7000 ', 7000],
    ['an integral float', 7000.0, 7000],
    ['an exponent', 7e3, 7000],
    ['the highest port', 65535, 65535],
    ['the highest port as a string', '65535', 65535]
  ])('reads the callback port when it is %s', (_label, callbackPort, expected) => {
    expect(readCdnOptions(section({ callbackPort }))?.callbackPort).toBe(expected)
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['zero', 0],
    ['negative zero', -0],
    ['negative', -1],
    ['a negative string', '-7000'],
    ['a float', 7000.5],
    ['a float string', '7000.5'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an empty string', ''],
    ['a blank string', '   '],
    ['a non-numeric string', 'port'],
    ['a partly numeric string', '7000abc'],
    ['an object', { port: 7000 }],
    ['an array of ports', [7000, 7001]],
    ['an array of one port', [7000]],
    ['false', false],
    ['true', true],
    ['a hexadecimal string', '0x1b58'],
    ['a binary string', '0b1'],
    ['an exponent string', '7e3'],
    ['a signed string', '+7000'],
    ['above the highest port', 65536],
    ['far above the highest port', 70000],
    ['above the highest port as a string', '70000']
  ])('falls back to the default callback port when it is %s', (_label, callbackPort) => {
    expect(readCdnOptions(section({ callbackPort }))?.callbackPort).toBe(6732)
  })

  it('ignores unknown fields', () => {
    expect(readCdnOptions({ ...section({ scope: 'openid' }), token: 'value' })).toEqual(readCdnOptions(section()))
  })

  it('leaves the section unchanged', () => {
    const raw = { url: 'https://cdn.example.dev/', openid: { issuer: 'https://auth.example.dev/', clientId: 'devtool', name: ' My SSO ', callbackPort: '7000' } }
    const copy = structuredClone(raw)

    readCdnOptions(raw)

    expect(raw).toEqual(copy)
  })
})
