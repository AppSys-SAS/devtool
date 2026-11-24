import { describe, expect, it } from 'vitest'
import { CommandSecrets, findInvalidValueBlocks } from '../../src/command-automation.js'
import type { CommandSecretsOptions } from '../../src/command-automation.js'

const USER: Record<string, string> = { token: 'token-123456', username: 'ada', groups: 'dev,ops' }

/**
 * Builds the reader of value blocks of a command, the signed-in developer being Ada.
 * @param options - Options overriding the defaults.
 * @returns The reader.
 */
function secretsOf (options: Partial<CommandSecretsOptions> = {}): CommandSecrets {
  return new CommandSecrets({
    account: null,
    folder: '/tmp',
    runShell: async command => `${command}\n`,
    readAuth: async value => {
      if (!(value in USER)) {
        throw new Error(`auth://${value}: no ${value}`)
      }
      return USER[value]
    },
    ...options
  })
}

describe('findInvalidValueBlocks', () => {
  it('accepts every value source', () => {
    expect(findInvalidValueBlocks('{{ op://vault/item/field }} {{ file://.env#/KEY }} {{ $(whoami) }} {{ auth://token }} {{ auth://groups }}')).toEqual([])
  })

  it('reports unknown sources and unknown values of the signed-in developer', () => {
    expect(findInvalidValueBlocks('{{ vault }} {{ auth://password }} {{ auth:// }}')).toEqual(['{{ vault }}', '{{ auth://password }}', '{{ auth:// }}'])
  })
})

describe('CommandSecrets', () => {
  it('reads the values of the signed-in developer and hides them from the output', async () => {
    const secrets = secretsOf()
    expect(await secrets.resolve('Bearer {{ auth://token }} for {{ auth://username }} in {{ auth://groups }}')).toBe('Bearer token-123456 for ada in dev,ops')
    expect(secrets.scrub('sent token-123456, groups dev,ops')).toBe('sent ••••, groups ••••')
  })

  it('reads the other sources as before', async () => {
    expect(await secretsOf().resolve('{{ $(echo hi) }}!')).toBe('echo hi!')
  })

  it('fails when the identity provider gives no such value', async () => {
    await expect(secretsOf().resolve('{{ auth://email }}')).rejects.toThrow('auth://email: no email')
  })
})
