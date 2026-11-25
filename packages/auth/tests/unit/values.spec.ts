import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CONFIG_FOLDER_VARIABLE } from '@appsys-sas/devtool-config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authValue, AuthSignInRequiredError, readAuthOptions, sessionStatus } from '../../src/index.js'

const OPTIONS = readAuthOptions({ name: 'My SSO', issuer: 'https://auth.example.dev', clientId: 'devtool' }).options!
const USER = { name: 'Ada Lovelace', username: 'ada', groups: ['dev', 'ops'] }

let folder: string
let previousFolder: string | undefined

/**
 * Saves a session the way a sign-in of the issuer of the tests does.
 * @param fields - Fields merged over a valid session of that issuer.
 */
async function saveSession (fields: Record<string, unknown> = {}): Promise<void> {
  const session = { issuer: OPTIONS.issuer, clientId: OPTIONS.clientId, accessToken: 'token-1', expiresAt: Date.now() + 3_600_000, refreshToken: null, user: USER, ...fields }
  await fs.writeFile(path.join(folder, 'session.json'), JSON.stringify(session))
}

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-auth-'))
  previousFolder = process.env[CONFIG_FOLDER_VARIABLE]
  process.env[CONFIG_FOLDER_VARIABLE] = folder
})

afterEach(async () => {
  if (previousFolder === undefined) {
    delete process.env[CONFIG_FOLDER_VARIABLE]
  } else {
    process.env[CONFIG_FOLDER_VARIABLE] = previousFolder
  }
  await fs.rm(folder, { recursive: true, force: true })
})

describe('authValue', () => {
  it('gives the token and the identity of the signed-in developer', async () => {
    await saveSession({ user: { ...USER, email: 'ada@example.dev' } })
    expect(await authValue(OPTIONS, 'token')).toBe('token-1')
    expect(await authValue(OPTIONS, 'username')).toBe('ada')
    expect(await authValue(OPTIONS, 'name')).toBe('Ada Lovelace')
    expect(await authValue(OPTIONS, 'email')).toBe('ada@example.dev')
    expect(await authValue(OPTIONS, 'groups')).toBe('dev,ops')
  })

  it('reads a session saved before the email was kept', async () => {
    await saveSession()
    expect(await authValue(OPTIONS, 'username')).toBe('ada')
    await expect(authValue(OPTIONS, 'email')).rejects.toThrow('auth://email: My SSO gives no email')
  })

  it('asks to sign in without a session, or with the session of another issuer', async () => {
    await expect(authValue(OPTIONS, 'username')).rejects.toBeInstanceOf(AuthSignInRequiredError)
    await saveSession({ issuer: 'https://other.example.dev' })
    await expect(authValue(OPTIONS, 'token')).rejects.toThrow('not signed in: run `devtool login`')
  })

  it('asks to sign in again when an expired session cannot be renewed', async () => {
    await saveSession({ expiresAt: Date.now() - 1000 })
    await expect(authValue(OPTIONS, 'groups')).rejects.toThrow('session expired: run `devtool login`')
  })
})

describe('sessionStatus', () => {
  it('describes the developer of a valid session', async () => {
    await saveSession()
    expect(await sessionStatus(OPTIONS)).toEqual({ signedIn: true, user: USER })
  })

  it('tells an expired session without refresh token is signed out', async () => {
    await saveSession({ expiresAt: Date.now() - 1000 })
    expect(await sessionStatus(OPTIONS)).toEqual({ signedIn: false, user: null })
  })
})
