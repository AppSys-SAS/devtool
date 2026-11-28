import type { EnvironmentRunPayload } from '@appsys-sas/devtool-shared'
import { describe, expect, it, vi } from 'vitest'
import { environmentTools } from '../../src/environment.js'
import type { McpHost } from '../../src/host.js'
import type { McpCall } from '../../src/tool.js'

/**
 * Runs `environment_sync` against an environment whose run in progress can change while the user
 * confirms, and whose own run starts, is refused because its configuration changed, or does not start.
 * @param during The run in progress once the user confirmed, null when there is none.
 * @param starts Whether the requested run starts, or the reason the environment refuses it.
 * @param error Why the environment cannot be used, null when it can.
 * @param revisions The configuration the items were described from, then the one the run is checked against.
 * @returns What the tool answered.
 */
async function sync (during: EnvironmentRunPayload | null, starts: boolean, error: string | null = null, revisions: [number, number] = [1, 1]): Promise<unknown> {
  let run: EnvironmentRunPayload | null = null
  const host = {
    config: { adt: { mcp: { environmentItems: [], environment: { run: { level: 'allow', from: 'test' } } } } },
    environment: {
      state: () => ({ run, error, revision: revisions[0], items: [{ path: 'api/a.txt', allowed: { pull: true, push: true } }] }),
      run: vi.fn(async (_action: string, _targets: unknown, _skipped: unknown, revision: number) => {
        if (revision !== revisions[1]) {
          run = { id: 'refused', action: 'pull', steps: [{ target: 'api/a.txt', status: 'failed', detail: 'the configuration changed since this was requested', progress: null }], finished: true }
        } else if (starts) {
          run = { id: 'agent', action: 'pull', steps: [], finished: false }
        }
      })
    }
  } as unknown as McpHost
  const call = {
    session: 'session',
    client: 'test',
    authorize: vi.fn(async () => {
      run = during
      return { decision: 'allow' as const, inputs: null }
    }),
    describe: () => undefined
  } as unknown as McpCall
  const tool = environmentTools(host).find(candidate => candidate.name === 'environment_sync')
  return tool?.run({ direction: 'pull', targets: [{ path: 'api/a.txt' }] }, call)
}

describe('environment_sync', () => {
  it('tells the run it started', async () => {
    expect(await sync(null, true)).toEqual({ started: 'pull', targets: ['api/a.txt'] })
  })

  it('refuses when another run started while the user confirmed', async () => {
    await expect(sync({ id: 'interface', action: 'restore', steps: [], finished: false }, false)).rejects.toThrow('A run over the environment is already in progress')
  })

  it('tells that nothing started when the configuration changed while the user confirmed', async () => {
    await expect(sync(null, true, null, [1, 2])).rejects.toThrow('Nothing started: the configuration changed since this was requested')
  })

  it('tells why an environment that cannot run started nothing', async () => {
    await expect(sync(null, false)).rejects.toThrow('The environment declares no backend it can use')
    await expect(sync(null, false, 'environment.files must be a list')).rejects.toThrow(/^The environment declares no backend it can use: environment\.files must be a list$/)
  })
})
