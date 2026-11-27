import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Environment } from '@appsys-sas/devtool-environment'
import type { EnvironmentPayload } from '@appsys-sas/devtool-shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DevtoolEnvironment } from '../../src/environment.js'

const LISTING = '{"files":[{"path":"api/a.txt","size":3,"updatedAt":"2026-01-01T00:00:00Z"},{"path":"api/b.txt","size":3,"updatedAt":"2026-01-01T00:00:00Z"}]}'

let folder: string
let published: EnvironmentPayload[]

/**
 * Builds the environment of two files on a scripts backend whose download waits before writing.
 * @param wait - The seconds each download waits.
 * @param listWait - The seconds each listing of the backend waits.
 * @returns The environment.
 */
function environmentOf (wait: number, listWait = 0): DevtoolEnvironment {
  const environment = new DevtoolEnvironment(async payload => {
    published.push(structuredClone(payload))
  }, async () => '')
  environment.configure({
    environment: {
      folder: path.join(folder, 'env'),
      backends: {
        shared: {
          type: 'scripts',
          list: ['bash', '-c', `sleep ${listWait}; printf %s '${LISTING}'`],
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
 * Builds the environment of one file on a scripts backend whose listing waits, both read from files
 * the test changes between refreshes.
 * @param wait - The seconds the listing waits.
 * @param size - The size the listing gives the file.
 * @returns The environment, and a way to change the wait and the size of the next listings.
 */
async function listedEnvironment (wait: number, size: number): Promise<{ environment: DevtoolEnvironment, list: (wait: number, size: number) => Promise<void> }> {
  const delayFile = path.join(folder, 'list-delay')
  const listingFile = path.join(folder, 'listing.json')
  /**
   * Sets the wait and the size of the next listings.
   * @param seconds - The seconds a listing waits.
   * @param bytes - The size a listing gives the file.
   */
  const list = async (seconds: number, bytes: number): Promise<void> => {
    await fs.writeFile(delayFile, String(seconds))
    await fs.writeFile(listingFile, JSON.stringify({ files: [{ path: 'api/a.txt', size: bytes, updatedAt: '2026-01-01T00:00:00Z' }] }))
  }
  await list(wait, size)
  const environment = new DevtoolEnvironment(async () => undefined, async () => '')
  environment.configure({
    environment: {
      folder: path.join(folder, 'env'),
      backends: { shared: { type: 'scripts', list: ['bash', '-c', 'listing=$(cat "$1"); sleep "$(cat "$0")"; printf %s "$listing"', delayFile, listingFile], download: ['true'], upload: ['true'], remove: ['true'] } },
      files: ['api/a.txt']
    }
  })
  return { environment, list }
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
    const environment = environmentOf(0, 3)
    const run = environment.run('remove', [{ path: 'api/a.txt', tables: null }])

    await vi.waitFor(() => expect(published.some(payload => payload.run?.finished === true)).toBe(true), { timeout: 1_500 })
    await run
  }, 10_000)

  it('keeps the items of the latest refresh when an earlier one ends after it', async () => {
    const { environment, list } = await listedEnvironment(1.5, 111)

    const earlier = environment.refresh()
    await delay(500)
    await list(0, 222)
    await environment.refresh()
    await earlier

    expect(environment.state().items[0].remote).toMatchObject({ size: 222 })
  }, 10_000)

  it('publishes an earlier refresh when the later one fails', async () => {
    const { environment } = await listedEnvironment(1, 111)

    const earlier = environment.refresh()
    await delay(300)
    vi.spyOn(Environment.prototype, 'describe').mockRejectedValueOnce(new Error('listing failed'))
    await expect(environment.refresh()).rejects.toThrow('listing failed')
    await earlier

    expect(environment.state().items[0].remote).toMatchObject({ size: 111 })
  }, 10_000)

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
