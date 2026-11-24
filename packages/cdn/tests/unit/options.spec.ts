import { describe, expect, it } from 'vitest'
import { readCdnOptions } from '../../src/options.js'

const AUTH = { issuer: 'https://auth.example.dev', clientId: 'devtool' }

describe('readCdnOptions', () => {
  it('reads the address of the CDN without its trailing slashes, with the sign-in settings', () => {
    expect(readCdnOptions({ url: 'https://cdn.example.dev//' }, AUTH)).toMatchObject({
      url: 'https://cdn.example.dev',
      auth: { type: 'openid', issuer: 'https://auth.example.dev', clientId: 'devtool' }
    })
  })

  it.each([
    ['https://cdn.example.dev/assets/', 'https://cdn.example.dev/assets'],
    ['https://cdn.example.dev//assets//', 'https://cdn.example.dev//assets']
  ])('normalizes the url %s to %s', (url, expected) => {
    expect(readCdnOptions({ url }, AUTH)?.url).toBe(expected)
  })

  it.each([
    ['missing', undefined],
    ['a string', 'https://cdn.example.dev'],
    ['an empty object', {}],
    ['a blank url', { url: ' ' }],
    ['a url that is not a text', { url: ['https://cdn.example.dev'] }]
  ])('gives null when the cdn section is %s', (_label, section) => {
    expect(readCdnOptions(section, AUTH)).toBeNull()
  })

  it.each([['missing', undefined], ['incomplete', { issuer: 'https://auth.example.dev' }]])('gives null when the auth section is %s', (_label, auth) => {
    expect(readCdnOptions({ url: 'https://cdn.example.dev' }, auth)).toBeNull()
  })
})
