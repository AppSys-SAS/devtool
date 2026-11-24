import { describe, expect, it } from 'vitest'
import { readAuthOptions } from '../../src/index.js'

/**
 * Builds a complete OpenID `auth` section whose fields can be overridden.
 * @param fields - Fields merged over the default section.
 * @returns A raw `auth` section.
 */
function section (fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { issuer: 'https://auth.example.dev', clientId: 'devtool', ...fields }
}

/**
 * Reads the options of a section, failing when it is incomplete.
 * @param fields - Fields merged over the default section.
 * @returns The options.
 */
function optionsOf (fields: Record<string, unknown> = {}): NonNullable<ReturnType<typeof readAuthOptions>['options']> {
  const { options } = readAuthOptions(section(fields))
  if (!options) {
    throw new Error('incomplete section')
  }
  return options
}

describe('readAuthOptions', () => {
  it('reads an OpenID section with its defaults', () => {
    expect(readAuthOptions(section())).toEqual({
      options: {
        type: 'openid',
        name: null,
        issuer: 'https://auth.example.dev',
        clientId: 'devtool',
        callbackPort: 6732,
        scopes: ['openid', 'offline_access', 'groups', 'profile']
      },
      problems: []
    })
  })

  it('reads every setting and strips the trailing slashes of the issuer', () => {
    expect(optionsOf({ type: 'openid', issuer: 'https://auth.example.dev/realms/dev//', name: ' My SSO ', callbackPort: '7000', scopes: ['openid', 'email'] })).toEqual({
      type: 'openid',
      name: 'My SSO',
      issuer: 'https://auth.example.dev/realms/dev',
      clientId: 'devtool',
      callbackPort: 7000,
      scopes: ['openid', 'email']
    })
  })

  it('gives nothing for a missing section', () => {
    expect(readAuthOptions(undefined)).toEqual({ options: null, problems: [] })
    expect(readAuthOptions(null)).toEqual({ options: null, problems: [] })
  })

  it.each([['a string', 'https://auth.example.dev'], ['a list', [section()]], ['a number', 1]])('reports a section that is %s', (_label, value) => {
    expect(readAuthOptions(value)).toEqual({ options: null, problems: [{ setting: 'auth', message: 'must be a map' }] })
  })

  it.each([['unknown', 'saml'], ['a number', 1]])('reports a type that is %s', (_label, type) => {
    expect(readAuthOptions(section({ type }))).toEqual({ options: null, problems: [{ setting: 'auth.type', message: 'must be one of openid' }] })
  })

  it.each([['missing', undefined], ['blank', ' '], ['a number', 1]])('reports an issuer or client that is %s', (_label, value) => {
    expect(readAuthOptions(section({ issuer: value })).options).toBeNull()
    expect(readAuthOptions(section({ issuer: value })).problems.map(problem => problem.setting)).toEqual(['auth.issuer'])
    expect(readAuthOptions(section({ clientId: value })).problems.map(problem => problem.setting)).toEqual(['auth.clientId'])
  })

  it.each([['zero', 0], ['above the highest port', 65536], ['a float', 7000.5], ['a word', 'port'], ['a list', [7000]]])('falls back to the default callback port when it is %s', (_label, callbackPort) => {
    const { options, problems } = readAuthOptions(section({ callbackPort }))
    expect(options?.callbackPort).toBe(6732)
    expect(problems).toEqual([{ setting: 'auth.callbackPort', message: 'must be a port between 1 and 65535, 6732 is used' }])
  })

  it.each([['without openid', ['profile']], ['a text', 'openid profile'], ['holding a blank', ['openid', ' ']]])('falls back to the default scopes when they are %s', (_label, scopes) => {
    const { options, problems } = readAuthOptions(section({ scopes }))
    expect(options?.scopes).toEqual(['openid', 'offline_access', 'groups', 'profile'])
    expect(problems.map(problem => problem.setting)).toEqual(['auth.scopes'])
  })

  it('leaves the section unchanged', () => {
    const raw = section({ issuer: 'https://auth.example.dev/', name: ' My SSO ', callbackPort: '7000' })
    const copy = structuredClone(raw)
    readAuthOptions(raw)
    expect(raw).toEqual(copy)
  })
})
