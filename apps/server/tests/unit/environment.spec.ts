import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Environment, type EnvironmentBackend } from '@appsys-sas/devtool-environment'
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
  environment.configure(configOf(wait))
  return environment
}

/**
 * Gives the configuration of two files on a scripts backend whose download waits before writing.
 * @param wait - The seconds each download waits.
 * @returns The raw configuration.
 */
function configOf (wait: number): Parameters<DevtoolEnvironment['configure']>[0] {
  return {
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
  }
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
 * Gives the run in progress or last finished.
 * @param environment - The environment.
 * @returns The identifier of the run, empty when none was started.
 */
function runIdOf (environment: DevtoolEnvironment): string {
  return environment.state().run?.id ?? ''
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
  it('runs a request made before the items were first described', async () => {
    const environment = environmentOf(0)
    await environment.run('pull', [{ path: 'api/a.txt', tables: null }], [], environment.state().revision)

    expect(environment.state().run?.steps.map(step => step.status)).toEqual(['done'])
    expect(await localCopy('a.txt')).toBe('new')
  })

  it('refuses a run requested on a configuration replaced since, every item failed and left as it was', async () => {
    const environment = environmentOf(0)
    await environment.refresh()
    const revision = environment.state().revision
    environment.configure(configOf(1))
    await environment.run('pull', [{ path: 'api/a.txt', tables: null }], [], revision)

    expect(environment.state().run?.steps.map(step => [step.status, step.detail])).toEqual([['failed', 'the configuration changed since this was requested: check the items and start again']])
    expect(await localCopy('a.txt')).toBe('old')
  })

  it('publishes the configuration its items were described from, refusing a request on it once replaced, then describes the new one', async () => {
    const environment = environmentOf(0)
    await environment.refresh()
    const described = environment.state().revision
    environment.configure(configOf(1))
    expect(environment.state().revision).toBe(described)
    await environment.run('pull', [{ path: 'api/a.txt', tables: null }], [], environment.state().revision)

    expect(environment.state().run?.steps.map(step => step.status)).toEqual(['failed'])
    expect(await localCopy('a.txt')).toBe('old')
    expect(environment.state().revision).toBeGreaterThan(described)
  })

  it('runs a request made before a reload that changed nothing of the environment', async () => {
    const environment = environmentOf(0)
    await environment.refresh()
    const revision = environment.state().revision
    environment.configure(configOf(0))
    await environment.run('pull', [{ path: 'api/a.txt', tables: null }], [], revision)

    expect(environment.state().run?.steps.map(step => step.status)).toEqual(['done'])
    expect(await localCopy('a.txt')).toBe('new')
  })

  it('tells why a request made on a configuration replaced by one without environment did nothing', async () => {
    const environment = environmentOf(0)
    await environment.refresh()
    const revision = environment.state().revision
    environment.configure({})
    await environment.run('pull', [{ path: 'api/a.txt', tables: null }], [], revision)

    expect(environment.state().run?.steps.map(step => step.status)).toEqual(['failed'])
  })

  it('drops an automatic pull whose configuration changes while its items are checked', async () => {
    const environment = environmentOf(0)
    await fs.rm(path.join(folder, 'env', 'api', 'a.txt'))
    const release = gatedDescribe(3)
    const pulling = environment.autoPull(['api/a.txt'])
    environment.configure(configOf(1))
    release()
    await pulling

    expect(environment.state().run).toBeNull()
    await expect(localCopy('a.txt')).rejects.toThrow()
  })

  it('cancels every item of a pull, the one downloading and the one waiting, leaving their copies as they were', async () => {
    const environment = environmentOf(5)
    const run = environment.run('pull', [{ path: 'api/a.txt', tables: null }, { path: 'api/b.txt', tables: null }])
    await running(0)
    environment.cancel(runIdOf(environment), null)
    await run

    expect(environment.state().run?.steps.map(step => [step.status, step.detail])).toEqual([['skipped', 'cancelled'], ['skipped', 'cancelled']])
    expect([await localCopy('a.txt'), await localCopy('b.txt')]).toEqual(['old', 'old'])
  }, 10_000)

  it('cancels one waiting item, the others pulled', async () => {
    const environment = environmentOf(0.3)
    const run = environment.run('pull', [{ path: 'api/a.txt', tables: null }, { path: 'api/b.txt', tables: null }])
    await running(0)
    environment.cancel(runIdOf(environment), 1)
    await run

    expect(environment.state().run?.steps.map(step => step.status)).toEqual(['done', 'skipped'])
    expect([await localCopy('a.txt'), await localCopy('b.txt')]).toEqual(['new', 'old'])
  }, 10_000)

  it('starts a run before returning, closing the backends a new configuration replaces only once it ends', async () => {
    const environment = environmentOf(0.3)
    const replaced = [...(environment as unknown as { _backends: { backends: Map<string, EnvironmentBackend> } })._backends.backends.values()]
    const closes = replaced.map(backend => vi.spyOn(backend, 'close'))
    const run = environment.run('pull', [{ path: 'api/a.txt', tables: null }])
    expect(environment.state().run?.finished).toBe(false)

    await running(0)
    environment.configure({ environment: { folder: path.join(folder, 'env'), files: ['api/a.txt'] } })
    expect(closes.every(close => close.mock.calls.length === 0)).toBe(true)
    await run
    expect(environment.state().run?.steps.map(step => step.status)).toEqual(['done'])
    expect(closes.every(close => close.mock.calls.length === 1)).toBe(true)
  }, 10_000)

  it('publishes the version of the copies, and tells why keys cannot be compared without a backend', async () => {
    const environment = environmentOf(0)
    await environment.refresh()
    expect(environment.state().items[0].remote).toMatchObject({ version: '2026-01-01T00:00:00.000Z' })

    environment.configure({ environment: { folder: path.join(folder, 'env'), files: ['api/a.txt'] } })
    expect(await environment.keys('api/a.txt')).toMatchObject({ error: 'the environment declares no backend it can use' })
  })

  it('closes the backends a new configuration replaces only once every operation using them ends', async () => {
    const environment = environmentOf(0)
    const replaced = [...(environment as unknown as { _backends: { backends: Map<string, EnvironmentBackend> } })._backends.backends.values()]
    const closes = replaced.map(backend => vi.spyOn(backend, 'close'))
    let release = (): void => undefined
    vi.spyOn(Environment.prototype, 'diffKeys').mockImplementationOnce(async () => new Promise(resolve => {
      release = () => resolve([])
    }))
    const keys = environment.keys('api/a.txt')

    environment.configure({ environment: { folder: path.join(folder, 'env'), files: ['api/a.txt'] } })
    expect(closes.every(close => close.mock.calls.length === 0)).toBe(true)
    release()
    expect(await keys).toMatchObject({ error: null })
    expect(closes.every(close => close.mock.calls.length === 1)).toBe(true)
  })

  it('publishes at once a waiting item cancelled while another one downloads', async () => {
    const environment = environmentOf(5)
    const run = environment.run('pull', [{ path: 'api/a.txt', tables: null }, { path: 'api/b.txt', tables: null }])
    await running(0)
    environment.cancel(runIdOf(environment), 1)

    expect(published.at(-1)?.run?.steps.map(step => [step.status, step.detail])).toEqual([['running', null], ['skipped', 'cancelled']])
    environment.cancel(runIdOf(environment), null)
    await run
    expect(environment.state().run?.steps.map(step => step.status)).toEqual(['skipped', 'skipped'])
  }, 10_000)

  it('cancels a push while its file uploads, the step skipped', async () => {
    const environment = new DevtoolEnvironment(async payload => {
      published.push(structuredClone(payload))
    }, async () => '')
    environment.configure({
      environment: {
        folder: path.join(folder, 'env'),
        backends: { shared: { type: 'scripts', list: ['printf', '%s', LISTING], download: ['true'], upload: ['bash', '-c', 'sleep 5'], remove: ['true'] } },
        files: ['api/a.txt']
      }
    })
    const started = Date.now()
    const run = environment.run('push', [{ path: 'api/a.txt', tables: null }])
    await running(0)
    environment.cancel(runIdOf(environment), null)
    await run

    expect(environment.state().run?.steps.map(step => [step.status, step.detail])).toEqual([['skipped', 'cancelled']])
    expect(Date.now() - started).toBeLessThan(4000)
  }, 10_000)

  it('forgets a finished run only when asked for that run', async () => {
    const environment = environmentOf(0)
    await environment.run('remove', [{ path: 'api/a.txt', tables: null }])
    const finished = runIdOf(environment)

    await environment.dismissRun('another run')
    expect(environment.state().run?.id).toBe(finished)
    await environment.dismissRun(finished)
    expect(environment.state().run).toBeNull()
  })

  it('ignores a cancel of a finished run reaching the next one', async () => {
    const environment = environmentOf(0.3)
    await environment.run('pull', [{ path: 'api/a.txt', tables: null }])
    const finished = runIdOf(environment)
    const run = environment.run('pull', [{ path: 'api/b.txt', tables: null }])
    await running(0)
    environment.cancel(finished, null)
    await run

    expect(environment.state().run?.steps.map(step => step.status)).toEqual(['done'])
    expect(await localCopy('b.txt')).toBe('new')
  }, 10_000)

  it('ends a run whose configuration becomes invalid while it runs, then starts the next one', async () => {
    const environment = environmentOf(0.3)
    const run = environment.run('pull', [{ path: 'api/a.txt', tables: null }, { path: 'api/b.txt', tables: null }])
    await running(0)
    environment.configure({ environment: { folder: path.join(folder, 'env'), sections: 'type' } })
    await run

    expect(environment.state().run?.finished).toBe(true)
    expect(environment.state().run?.steps.every(step => step.status === 'done' || step.status === 'failed')).toBe(true)
    const next = environmentOf(0)
    await next.run('pull', [{ path: 'api/a.txt', tables: null }])
    expect(next.state().run?.steps.map(step => step.status)).toEqual(['done'])
  }, 10_000)

  it('refuses a database restricted to no table instead of transferring it whole', async () => {
    const environment = new DevtoolEnvironment(async () => undefined, async () => '')
    environment.configure({
      environment: {
        folder: path.join(folder, 'env'),
        backends: { shared: { type: 'scripts', list: ['printf', '%s', '{"files":[]}'], download: ['true'], upload: ['true'], remove: ['true'] } },
        databases: [{ path: 'api/db.gz', engine: 'postgres', container: 'db' }]
      }
    })
    await environment.run('restore', [{ path: 'api/db.gz', tables: [] }])
    expect(environment.state().run?.steps).toEqual([{ target: 'api/db.gz', status: 'failed', detail: 'no table or key group chosen for api/db.gz', progress: null }])

    await environment.run('remove', [{ path: 'api/db.gz', tables: [] }])
    expect(environment.state().run?.steps.map(step => step.status)).toEqual(['done'])
  })

  it('refuses tables for an item that has none instead of transferring it whole', async () => {
    const environment = environmentOf(0)
    await environment.run('pull', [{ path: 'api/a.txt', tables: ['users'] }])

    expect(environment.state().run?.steps.map(step => [step.status, step.detail])).toEqual([['failed', 'api/a.txt has no tables or key groups to choose from']])
    expect(await localCopy('a.txt')).toBe('old')
  })

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

  it('publishes why a refresh failed, then an earlier refresh ending after it', async () => {
    const environment = environmentOf(0)
    const releaseEarlier = gatedDescribe(111)
    vi.mocked(Environment.prototype.describe).mockRejectedValueOnce(new Error('listing failed'))
    const earlier = environment.refresh()

    await environment.refresh()
    expect(published.at(-1)).toMatchObject({ error: 'the environment could not be described: listing failed', refreshing: true })
    releaseEarlier()
    await earlier
    expect(remoteSizes(environment)).toEqual([111, 111])
    expect(published.at(-1)).toMatchObject({ error: null, refreshing: false })
  })

  it('never publishes the items of a refresh started before the configuration changed', async () => {
    const environment = environmentOf(0)
    const release = gatedDescribe(111)
    const earlier = environment.refresh()
    environment.configure({ environment: { backends: { shared: { type: 'scripts' } } } })
    const { error } = environment.state()
    expect(error).not.toBeNull()

    release()
    await earlier
    expect(environment.state().error).toBe(error)
    expect(remoteSizes(environment)).toEqual([])
  })

  it('keeps the outcome of a later refresh when an earlier one fails after it', async () => {
    const environment = environmentOf(0)
    let failEarlier = (): void => undefined
    vi.spyOn(Environment.prototype, 'describe').mockImplementationOnce(async () => new Promise((_resolve, reject) => {
      failEarlier = () => {
        reject(new Error('backend exploded'))
      }
    }))
    const earlier = environment.refresh()
    await environment.refresh()
    failEarlier()
    await earlier

    expect(published.at(-1)).toMatchObject({ error: null, refreshing: false })
  })

  it('publishes that it refreshes until the items are described', async () => {
    const environment = environmentOf(0)
    const release = gatedDescribe(111)
    const refresh = environment.refresh()

    await vi.waitFor(() => expect(published.at(-1)?.refreshing).toBe(true))
    release()
    await refresh
    expect(published.at(-1)).toMatchObject({ refreshing: false })
    expect(remoteSizes(environment)).toEqual([111, 111])
  })

  it('ignores the progress a transfer reports once its step ended', async () => {
    const environment = environmentOf(0)
    let report: ((done: number, total: number | null) => void) | undefined
    vi.spyOn(Environment.prototype, 'pull').mockImplementationOnce(async ({ onProgress }) => {
      report = onProgress
      return { done: true, detail: 'pulled' }
    })
    await environment.run('pull', [{ path: 'api/a.txt', tables: null }])
    const publications = published.length
    report?.(5, 10)

    await new Promise(resolve => {
      setTimeout(resolve, 300)
    })
    expect(environment.state().run?.steps[0]).toMatchObject({ status: 'done', progress: null })
    expect(published).toHaveLength(publications)
  })

  it('starts nothing for an unknown action', async () => {
    const environment = environmentOf(0)
    await environment.run('erase' as 'pull', [{ path: 'api/a.txt', tables: null }])

    expect(environment.state().run).toBeNull()
    expect(published).toEqual([])
    expect(await localCopy('a.txt')).toBe('old')
  })

  it('ignores a cancel outside a pull, and reports a failure as a failure', async () => {
    const environment = environmentOf(0)
    const run = environment.run('restore', [{ path: 'api/a.txt', tables: null }])
    environment.cancel(runIdOf(environment), null)
    await run

    expect(environment.state().run?.steps).toEqual([
      { target: 'api/a.txt', status: 'failed', detail: 'api/a.txt is a file: its local copy is its data, pull it instead', progress: null }
    ])
    expect(environment.state().run?.action).toBe('restore')
  })
})
