import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackendContext } from '../../src/environment.js'

vi.mock('@appsys-sas/devtool-environment', async original => ({ ...await original<typeof import('@appsys-sas/devtool-environment')>(), DEVELOPER_ANSWER_MS: 300 }))

let folder: string

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-backend-context-'))
  vi.stubEnv('ADT_CONFIG_FOLDER', folder)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fs.rm(folder, { recursive: true, force: true })
})

describe('createBackendContext', () => {
  it('reads a value block from a command, stopping one that does not answer within the time the developer has', async () => {
    const context = createBackendContext({}, async () => '')
    expect(await context.resolve('{{ $(echo token) }}')).toBe('token')

    const started = Date.now()
    await expect(context.resolve('{{ $(sleep 5; echo late) }}')).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
