import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type AuthOptions, sessionStatus } from '@appsys-sas/devtool-auth'
import { mergeTransferGroups, readTransferGroups, TransferGate } from '../../src/access.js'
import type { BackendContext, EnvironmentBackend } from '../../src/backends/backend.js'
import { Environment, type EnvironmentItem } from '../../src/environment.js'

vi.mock('@appsys-sas/devtool-auth', () => ({ sessionStatus: vi.fn() }))

const AUTH = { type: 'openid', name: null } as unknown as AuthOptions

/**
 * Makes the saved session hold a developer of some groups.
 * @param groups - The groups, null for no signed-in developer.
 */
function signIn (groups: string[] | null): void {
  vi.mocked(sessionStatus).mockResolvedValue(groups === null
    ? { signedIn: false, user: null }
    : { signedIn: true, user: { name: 'Dev', username: 'dev', groups } })
}

beforeEach(() => {
  vi.mocked(sessionStatus).mockReset()
})

describe('readTransferGroups', () => {
  it('reads lists of groups and false, a missing direction letting everyone in', () => {
    expect(readTransferGroups(undefined)).toEqual({ groups: { pull: null, push: null }, problems: [] })
    expect(readTransferGroups({ pull: ['developers'], push: false })).toEqual({ groups: { pull: ['developers'], push: false }, problems: [] })
  })

  it('reports empty lists, true, unknown keys and other shapes', () => {
    expect(readTransferGroups({ pull: [], push: true, read: ['x'] }).problems).toEqual([
      'read is unknown: only pull and push',
      'pull must be a non-empty list of groups, or false',
      'push must be a non-empty list of groups, or false'
    ])
    expect(readTransferGroups(['admins']).problems).toEqual(['must be a map of pull and push groups'])
  })
})

describe('mergeTransferGroups', () => {
  it('replaces the groups of the backend by those the item names, direction by direction', () => {
    expect(mergeTransferGroups({ pull: null, push: ['admins'] }, { pull: ['developers'], push: ['developers'] })).toEqual({ pull: ['developers'], push: ['admins'] })
    expect(mergeTransferGroups({ pull: false, push: null }, { pull: null, push: null })).toEqual({ pull: false, push: null })
  })

  it('keeps a direction the backend refuses to everyone refused', () => {
    expect(mergeTransferGroups({ pull: ['admins'], push: ['admins'] }, { pull: null, push: false })).toEqual({ pull: ['admins'], push: false })
  })
})

describe('TransferGate', () => {
  it('lets everyone in without groups, and nobody with false, without reading the session', async () => {
    const gate = new TransferGate(AUTH)
    expect(await gate.refusal(null, 'pull')).toBeNull()
    expect(await gate.refusal(false, 'push')).toBe('push is disabled')
    expect(sessionStatus).not.toHaveBeenCalled()
  })

  it('lets in the members of one of the groups only', async () => {
    signIn(['developers'])
    const gate = new TransferGate(AUTH)
    expect(await gate.refusal(['admins', 'developers'], 'pull')).toBeNull()
    expect(await gate.refusal(['admins'], 'push')).toBe('push needs one of the groups admins')
    expect(sessionStatus).toHaveBeenCalledTimes(1)
  })

  it('asks for a sign-in when no developer is signed in, and names a missing auth section', async () => {
    signIn(null)
    expect(await new TransferGate(AUTH).refusal(['admins'], 'pull')).toBe('pull needs one of the groups admins: sign in with `devtool login`')
    expect(await new TransferGate(null).refusal(['admins'], 'pull')).toBe('pull needs one of the groups admins, and the configuration declares no auth section')
  })
})

describe('Environment groups', () => {
  const backend: EnvironmentBackend = {
    list: vi.fn(async () => []),
    download: vi.fn(async () => null),
    upload: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined)
  }
  const context: BackendContext = { resolve: async text => text, askSecret: async () => '', cacheDir: '/example/cache', configFolder: '/example/config', auth: AUTH }

  /**
   * Builds an environment holding one item of the backend.
   * @param groups - Who may pull and push the item.
   * @returns The environment and its item.
   */
  function environmentWith (groups: EnvironmentItem['groups']): { environment: Environment, item: EnvironmentItem } {
    const item: EnvironmentItem = { kind: 'file', path: 'api/config.yml', backend: 'team', encryption: null, groups, ignore: null }
    const environment = new Environment(new Map([['team', backend]]), { folder: '/example/env', backends: [], defaultBackend: 'team', items: [item], configFiles: [], autoPulls: [], s3: null }, context)
    return { environment, item }
  }

  it('refuses a transfer the groups of the developer do not allow before reaching the backend', async () => {
    signIn(['developers'])
    const { environment, item } = environmentWith({ pull: ['admins'], push: false })

    await expect(environment.pull({ item, tables: null })).rejects.toThrow('api/config.yml: pull needs one of the groups admins')
    await expect(environment.push({ item, tables: null })).rejects.toThrow('api/config.yml: push is disabled')
    expect(backend.download).not.toHaveBeenCalled()
    expect(backend.upload).not.toHaveBeenCalled()
  })

  it('refuses to read the copy of the backend for a key comparison without the pull groups', async () => {
    signIn(['developers'])
    const { environment, item } = environmentWith({ pull: ['admins'], push: null })

    await expect(environment.diffKeys(item)).rejects.toThrow('api/config.yml: pull needs one of the groups admins')
    expect(backend.download).not.toHaveBeenCalled()
  })

  it('transfers when the groups of the developer allow it', async () => {
    signIn(['developers'])
    const { environment, item } = environmentWith({ pull: ['developers'], push: null })

    expect(await environment.pull({ item, tables: null })).toEqual({ done: false, detail: 'absent from team' })
    expect(backend.download).toHaveBeenCalledWith('api/config.yml')
  })
})
