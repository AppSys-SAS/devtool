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
    await expect(context.resolve('{{ $(sleep 5; echo late) }}')).rejects.toThrow('did not end within')
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('gives the value of a command by the time the developer has, though a process it detached keeps its output open', async () => {
    const context = createBackendContext({}, async () => '')
    const pidFile = path.join(folder, 'detached')
    const started = Date.now()

    try {
      expect(await context.resolve(`{{ $(sleep 30 & echo $! > "${pidFile}"; echo value) }}`)).toBe('value')
      expect(Date.now() - started).toBeLessThan(3000)
    } finally {
      const pid = Number((await fs.readFile(pidFile, 'utf-8').catch(() => '')).trim())
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          void pid
        }
      }
    }
  })

  it('kills the processes a value block command started once it does not answer in time', async () => {
    const context = createBackendContext({}, async () => '')
    const pidFile = path.join(folder, 'child')

    await expect(context.resolve(`{{ $(sleep 30 & echo $! > "${pidFile}"; wait) }}`)).rejects.toThrow('did not end within')
    const child = Number((await fs.readFile(pidFile, 'utf-8')).trim())
    expect(child).toBeGreaterThan(0)
    expect(() => process.kill(child, 0)).toThrow()
  })
})
