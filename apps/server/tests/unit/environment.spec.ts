import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Environment } from '@appsys-sas/devtool-environment'
import type { EnvironmentPayload } from '@appsys-sas/devtool-shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DevtoolEnvironment } from '../../src/environment.js'

const LISTING = '{"files":[{"path":"api/a.txt","size":3,"updatedAt":"2026-01-01T00:00:00Z"},{"path":"api/b.txt","size":3,"updatedAt":"2026-01-01T00:00:00Z"}]}'
const describeItems = Environment.prototype.describe

let folder: string
let published: EnvironmentPayload[]

/**
 * Builds the environment of two files on a scripts backend whose download waits before writing.
 * @param wait - The seconds each download waits.
 * @returns The environment.
 */
function environmentOf (wait: number): DevtoolEnvironment {
  const environment = new DevtoolEnvironment(async payload => {
    published.push(structuredClone(payload))
  }, async () => '')
  environment.configure({
    environment: {
      folder: path.join(folder, 'env'),
      backends: {
        shared: {
          type: 'scripts',
          list: ['printf', '%s', LISTING],
          download: ['bash', '-c', `sleep ${wait}; printf new > "$0"`, '%{ADT:FILE}'],
          upload: ['true'],
          remove: ['true']
        }
      },
      files: ['api/a.txt', 'api/b.txt']
    }
  })
  return environment
}

/**
 * Makes the next description of the items wait until released, then gives every item a copy on its
 * backend of one size.
 * @param size - The size of the copies on the backend.
 * @returns Releases the description.
 */
function gatedDescribe (size: number): () => void {
  let release = (): void => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  vi.spyOn(Environment.prototype, 'describe').mockImplementationOnce(async function (this: Environment) {
    await gate
    const described = await describeItems.call(this)
    return { ...described, items: described.items.map(entry => ({ ...entry, remote: { size, updatedAt: new Date(0), version: String(size) } })) }
  })
  return release
}

/**
 * Gives the size of the copy on its backend of each item, as last published.
 * @param environment - The environment.
 * @returns The sizes, in the order of the items.
 */
function remoteSizes (environment: DevtoolEnvironment): (number | null)[] {
  return environment.state().items.map(item => (item.remote && item.remote !== 'unknown' ? item.remote.size : null))
}

/**
 * Reads the local copy of a file of the environment.
 * @param name - The name of the file.
 * @returns Its content.
 */
async function localCopy (name: string): Promise<string> {
  return fs.readFile(path.join(folder, 'env', 'api', name), 'utf-8')
}

/**
 * Waits until the run publishes a step running.
 * @param index - The step.
 */
async function running (index: number): Promise<void> {
  await vi.waitFor(() => expect(published.at(-1)?.run?.steps[index].status).toBe('running'))
}

beforeEach(async () => {
  folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-server-env-')))
  published = []
  await fs.mkdir(path.join(folder, 'env', 'api'), { recursive: true })
  await fs.writeFile(path.join(folder, 'env', 'api', 'a.txt'), 'old')
  await fs.writeFile(path.join(folder, 'env', 'api', 'b.txt'), 'old')
  vi.stubEnv('ADT_CONFIG_FOLDER', folder)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await fs.rm(folder, { recursive: true, force: true })
})

describe('DevtoolEnvironment run', () => {
  it('cancels every item of a pull, the one downloading and the one waiting, leaving their copies as they were', async () => {
    const environment = environmentOf(5)
    const run = environment.run('pull', [{ path: 'api/a.txt', tables: null }, { path: 'api/b.txt', tables: null }])
    await running(0)
    environment.cancel(null)
    await run

    expect(environment.state().run?.steps.map(step => [step.status, step.detail])).toEqual([['skipped', 'cancelled'], ['skipped', 'cancelled']])
    expect([await localCopy('a.txt'), await localCopy('b.txt')]).toEqual(['old', 'old'])
  }, 10_000)

  it('cancels one waiting item, the others pulled', async () => {
    const environment = environmentOf(0.3)
    const run = environment.run('pull', [{ path: 'api/a.txt', tables: null }, { path: 'api/b.txt', tables: null }])
    await running(0)
    environment.cancel(1)
    await run

    expect(environment.state().run?.steps.map(step => step.status)).toEqual(['done', 'skipped'])
    expect([await localCopy('a.txt'), await localCopy('b.txt')]).toEqual(['new', 'old'])
  }, 10_000)

  it('publishes the end of a run before describing the items again', async () => {
    const environment = environmentOf(0)
    const release = gatedDescribe(0)
    const run = environment.run('remove', [{ path: 'api/a.txt', tables: null }])

    await vi.waitFor(() => expect(published.some(payload => payload.run?.finished === true)).toBe(true))
    release()
    await run
  })

  it('keeps the items of the latest refresh when an earlier one ends after it', async () => {
    const environment = environmentOf(0)
    const releaseEarlier = gatedDescribe(111)
    const releaseLater = gatedDescribe(222)
    const earlier = environment.refresh()
    const later = environment.refresh()

    releaseLater()
    await later
    expect(remoteSizes(environment)).toEqual([222, 222])
    releaseEarlier()
    await earlier
    expect(remoteSizes(environment)).toEqual([222, 222])
  })

  it('publishes an earlier refresh when the later one fails', async () => {
    const environment = environmentOf(0)
    const releaseEarlier = gatedDescribe(111)
    vi.mocked(Environment.prototype.describe).mockRejectedValueOnce(new Error('listing failed'))
    const earlier = environment.refresh()

    await expect(environment.refresh()).rejects.toThrow('listing failed')
    releaseEarlier()
    await earlier
    expect(remoteSizes(environment)).toEqual([111, 111])
  })

  it('ignores a cancel outside a pull, and reports a failure as a failure', async () => {
    const environment = environmentOf(0)
    const run = environment.run('restore', [{ path: 'api/a.txt', tables: null }])
    environment.cancel(null)
    await run

    expect(environment.state().run?.steps).toEqual([
      { target: 'api/a.txt', status: 'failed', detail: 'api/a.txt is a file: its local copy is its data, pull it instead', progress: null }
    ])
    expect(environment.state().run?.action).toBe('restore')
  })
})
