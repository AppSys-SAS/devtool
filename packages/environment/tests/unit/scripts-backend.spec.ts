import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransferAccess } from '../../src/access.js'
import { type BackendContext, type BackendSettings, type EnvironmentBackend, PossiblyStoredError } from '../../src/backends/backend.js'
import { scripts } from '../../src/backends/scripts.js'
import { progressRecorder } from './progress-fixtures.js'

const FOLDER_SCRIPT = path.resolve(import.meta.dirname, '../../../../docs/examples/scripts-backend/folder.sh')
const hasBash = ((): boolean => {
  try {
    execFileSync('bash', ['-c', 'true'])
    return true
  } catch {
    return false
  }
})()

let folder: string
let root: string

/**
 * Builds the context of a backend whose value blocks hold no block.
 * @returns The context.
 */
function contextOf (): BackendContext {
  return { resolve: async text => text, askSecret: async () => '', cacheDir: folder, configFolder: folder, auth: null }
}

/**
 * Builds the settings every backend shares.
 * @param groups - Who may pull and push.
 * @returns The shared settings.
 */
function sharedOf (groups: TransferAccess = { pull: null, push: null }): BackendSettings {
  return { type: 'scripts', slug: 'shared', default: true, encryption: null, groups }
}

/**
 * Creates a scripts backend from raw settings.
 * @param settings - The raw settings of the backend.
 * @returns The backend.
 */
function backendOf (settings: Record<string, unknown>): EnvironmentBackend {
  const { options, problems } = scripts.readOptions(settings, sharedOf(), 'environment.backends.shared')
  if (!options) {
    throw new Error(JSON.stringify(problems))
  }
  return scripts.create(options, contextOf())
}

/**
 * Builds a backend running the example folder script on the temporary root.
 * @returns The backend.
 */
function folderBackend (): EnvironmentBackend {
  return backendOf({
    list: [FOLDER_SCRIPT, 'list'],
    download: [FOLDER_SCRIPT, 'download', '%{ADT:PATH}', '%{ADT:FILE}'],
    upload: [FOLDER_SCRIPT, 'upload', '%{ADT:PATH}', '%{ADT:FILE}'],
    remove: [FOLDER_SCRIPT, 'remove', '%{ADT:PATH}'],
    env: { ROOT: root }
  })
}

/**
 * Waits for a command to write the identifier of a process it started, written to a temporary file
 * then renamed so that it is never read half written.
 * @param pidFile - The file holding the identifier.
 * @param timeout - How long to wait for it, in milliseconds.
 * @returns The identifier, always a positive number.
 */
async function pidOf (pidFile: string, timeout = 5000): Promise<number> {
  return vi.waitFor(async () => {
    const pid = Number((await fs.readFile(pidFile, 'utf-8')).trim())
    expect(Number.isInteger(pid) && pid > 0).toBe(true)
    return pid
  }, { timeout })
}

/**
 * Kills a process a command left running, when its file holds a valid identifier.
 * @param pidFile - The file holding the identifier.
 */
async function killLeft (pidFile: string): Promise<void> {
  const pid = Number((await fs.readFile(pidFile, 'utf-8').catch(() => '')).trim())
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      return
    }
  }
}

/**
 * Reads a whole stream as text.
 * @param stream - The stream.
 * @returns The text.
 */
async function textOf (stream: Readable | null): Promise<string | null> {
  if (stream === null) {
    return null
  }
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Writes a local file to upload.
 * @param name - The name of the file.
 * @param content - Its content.
 * @returns Its path.
 */
async function localFile (name: string, content: string): Promise<string> {
  const file = path.join(folder, name)
  await fs.writeFile(file, content)
  return file
}

beforeEach(async () => {
  folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-scripts-')))
  root = path.join(folder, 'root')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(folder, { recursive: true, force: true })
})

describe.skipIf(!hasBash)('scripts backend with the example folder script', () => {
  it('lists nothing before the first upload', async () => {
    expect(await folderBackend().list()).toEqual([])
  })

  it('uploads, lists, downloads and removes files, nested and with spaces', async () => {
    const backend = folderBackend()
    await backend.upload('api/config.yml', await localFile('a', 'port: 3000\n'), 'application/yaml')
    await backend.upload('team files/db dump.gz', await localFile('b', 'dump'), 'application/gzip')

    const files = (await backend.list())!.sort((a, b) => a.path.localeCompare(b.path))
    expect(files.map(file => [file.path, file.size])).toEqual([['api/config.yml', 11], ['team files/db dump.gz', 4]])
    expect(files[0].updatedAt).toBeInstanceOf(Date)
    expect(files[0].version).toMatch(/^\d+-11$/)

    expect(await textOf(await backend.download('team files/db dump.gz'))).toBe('dump')
    expect(await textOf(await backend.download('api/config.yml'))).toBe('port: 3000\n')

    await backend.remove('api/config.yml')
    await backend.remove('api/config.yml')
    expect((await backend.list())!.map(file => file.path)).toEqual(['team files/db dump.gz'])
  })

  it('gives null for a file the folder does not hold', async () => {
    expect(await folderBackend().download('missing.yml')).toBeNull()
  })

  it('replaces a stored file on upload', async () => {
    const backend = folderBackend()
    await backend.upload('api/config.yml', await localFile('a', 'old'), 'application/yaml')
    await backend.upload('api/config.yml', await localFile('b', 'new content'), 'application/yaml')
    expect(await textOf(await backend.download('api/config.yml'))).toBe('new content')
    expect((await backend.list())!.map(file => file.size)).toEqual([11])
  })
})

describe.skipIf(!hasBash)('scripts backend commands', () => {
  it('reports the end of the standard error of a failing command', async () => {
    const failing = ['bash', '-c', 'echo "storage unreachable" >&2; exit 5']
    const backend = backendOf({ list: failing, download: failing, upload: failing, remove: failing })
    await expect(backend.list()).rejects.toThrow('list of shared failed (exit 5): storage unreachable')
    await expect(backend.download('x')).rejects.toThrow('download of shared failed (exit 5)')
  })

  it('refuses a listing that is not the expected JSON', async () => {
    const backend = backendOf({ list: ['bash', '-c', 'echo not json'], download: ['true'], upload: ['true'], remove: ['true'] })
    await expect(backend.list()).rejects.toThrow('the list command printed no JSON')
    const invalid = backendOf({ list: ['bash', '-c', 'echo \'{"files":[{"path":"a"}]}\''], download: ['true'], upload: ['true'], remove: ['true'] })
    await expect(invalid.list()).rejects.toThrow('the list command printed an invalid file')
    const textSize = backendOf({ list: ['bash', '-c', 'echo \'{"files":[{"path":"a","size":"big","updatedAt":"2026-01-02T03:04:05Z"}]}\''], download: ['true'], upload: ['true'], remove: ['true'] })
    await expect(textSize.list()).rejects.toThrow('the list command printed an invalid file')
  })

  it('reads a listing that leaves out the size of a file as a size it does not know', async () => {
    const backend = backendOf({ list: ['bash', '-c', 'echo \'{"files":[{"path":"a","updatedAt":"2026-01-02T03:04:05Z"},{"path":"b","size":null,"updatedAt":"2026-01-02T03:04:05Z"}]}\''], download: ['true'], upload: ['true'], remove: ['true'] })
    expect((await backend.list())?.map(file => [file.path, file.size])).toEqual([['a', null], ['b', null]])
  })

  it('reads the value blocks of the arguments and of the environment, and defaults the version to the date', async () => {
    const context: BackendContext = { ...contextOf(), resolve: async text => text.replace('{{ secret }}', 's3cr3t') }
    const { options } = scripts.readOptions({
      list: ['bash', '-c', 'printf \'{"files":[{"path":"%s","size":1,"updatedAt":"2026-01-02T03:04:05Z"}]}\' "$TOKEN-$0"', '{{ secret }}'],
      download: ['true'],
      upload: ['true'],
      remove: ['true'],
      env: { TOKEN: '{{ secret }}' }
    }, sharedOf(), 'environment.backends.shared')
    const files = await scripts.create(options!, context).list()
    expect(files).toEqual([{ path: 's3cr3t-s3cr3t', size: 1, updatedAt: new Date('2026-01-02T03:04:05Z'), version: '2026-01-02T03:04:05.000Z' }])
  })

  it('reports the size of the file the download command writes while it runs, then once it is written', async () => {
    const backend = backendOf({
      list: ['true'],
      download: ['bash', '-c', 'printf %s "$0" > "$1"; sleep 0.8; printf %s "$0$0" > "$1"', 'abcdef', '%{ADT:FILE}'],
      upload: ['true'],
      remove: ['true']
    })
    const received = progressRecorder()
    expect(await textOf(await backend.download('a.gz', { onProgress: received.onProgress }))).toBe('abcdefabcdef')
    expect(received.reports).toContainEqual([6, null])
    expect(received.reports.at(-1)).toEqual([12, null])
  })

  it('reports the progress lines of the upload command, split or not, against the size of the file', async () => {
    const backend = backendOf({
      list: ['true'],
      download: ['true'],
      upload: ['bash', '-c', 'echo "progress: 4" >&2; echo "progress: 5 of 10" >&2; printf "progr" >&2; sleep 0.2; echo "ess: 9" >&2; echo "progress: 99" >&2'],
      remove: ['true']
    })
    const sent = progressRecorder()
    await backend.upload('a.gz', await localFile('a.gz', '0123456789'), 'application/gzip', { onProgress: sent.onProgress })
    expect(sent.reports).toEqual([[4, 10], [9, 10], [99, 10]])
  })

  it('leaves the progress lines out of the message of a failing command', async () => {
    const failing = ['bash', '-c', 'echo "progress: 4" >&2; echo "storage full" >&2; exit 1']
    const backend = backendOf({ list: ['true'], download: ['true'], upload: failing, remove: ['true'] })
    await expect(backend.upload('a.gz', await localFile('a.gz', 'x'), 'application/gzip')).rejects.toThrow(/failed \(exit 1\): storage full$/)
  })

  it('stops the list command its signal cancels', async () => {
    const backend = backendOf({ list: ['bash', '-c', 'sleep 10'], download: ['true'], upload: ['true'], remove: ['true'] })
    const cancel = new AbortController()
    setTimeout(() => cancel.abort(new Error('cancelled')), 300)
    const started = Date.now()
    await expect(backend.list(cancel.signal)).rejects.toThrow('list of shared stopped')
    expect(Date.now() - started).toBeLessThan(2000)
  }, 10_000)

  it('kills what a cancelled download command left running once the command ends', async () => {
    const marker = path.join(folder, 'written-after-cancel')
    const backend = backendOf({
      list: ['true'],
      download: ['bash', '-c', '(trap "" TERM; sleep 1.5; touch "$1") > /dev/null 2>&1 & printf partial > "$0"; wait', '%{ADT:FILE}', marker],
      upload: ['true'],
      remove: ['true']
    })
    const cancel = new AbortController()
    setTimeout(() => cancel.abort(new Error('cancelled')), 300)
    await expect(backend.download('a.gz', { signal: cancel.signal })).rejects.toThrow('download of shared stopped')
    await delay(2000)
    await expect(fs.access(marker)).rejects.toThrow()
  }, 10_000)

  it('stops the download command its signal cancels, with the processes it started', async () => {
    const marker = path.join(folder, 'written-after-cancel')
    const backend = backendOf({
      list: ['true'],
      download: ['bash', '-c', '(sleep 1; touch "$1") & printf partial > "$0"; wait', '%{ADT:FILE}', marker],
      upload: ['true'],
      remove: ['true']
    })
    const cancel = new AbortController()
    setTimeout(() => cancel.abort(new Error('cancelled')), 300)
    const started = Date.now()
    await expect(backend.download('a.gz', { signal: cancel.signal })).rejects.toThrow('download of shared stopped')
    expect(Date.now() - started).toBeLessThan(1000)
    await delay(1500)
    await expect(fs.access(marker)).rejects.toThrow()
  }, 10_000)

  it('kills a cancelled command ignoring the stop request once its grace delay is over', async () => {
    const backend = backendOf({ list: ['true'], download: ['bash', '-c', 'trap "" TERM; sleep 30'], upload: ['true'], remove: ['true'] })
    const cancel = new AbortController()
    setTimeout(() => cancel.abort(new Error('cancelled')), 300)
    const started = Date.now()
    await expect(backend.download('a.gz', { signal: cancel.signal })).rejects.toThrow('download of shared stopped')
    expect(Date.now() - started).toBeGreaterThanOrEqual(5000)
    expect(Date.now() - started).toBeLessThan(8000)
  }, 15_000)

  it('passes a stop signal of the devtool on to a cancellable command and the processes it started', async () => {
    const pidFile = path.join(folder, 'started')
    const backend = backendOf({ list: ['true'], download: ['bash', '-c', 'sleep 30 & echo $! > "$0.tmp"; mv "$0.tmp" "$0"; wait', pidFile], upload: ['true'], remove: ['true'] })
    const listeners = process.listenerCount('SIGTERM')
    const kill = process.kill.bind(process)
    const raised: (string | number | undefined)[] = []
    vi.spyOn(process, 'kill').mockImplementation((pid, name) => {
      if (pid === process.pid) {
        raised.push(name)
        return true
      }
      return kill(pid, name)
    })
    const download = backend.download('a.gz', { signal: new AbortController().signal })
    const sleeper = await pidOf(pidFile)
    process.emit('SIGTERM', 'SIGTERM')

    await expect(download).rejects.toThrow('download of shared failed')
    expect(() => kill(sleeper, 0)).toThrow()
    expect(process.listenerCount('SIGTERM')).toBe(listeners)
    expect(raised).toEqual(listeners === 0 ? ['SIGTERM'] : [])
  }, 10_000)

  it('leaves a stop signal to the listener the devtool already has, after passing it on', async () => {
    const pidFile = path.join(folder, 'started')
    const backend = backendOf({ list: ['true'], download: ['bash', '-c', 'sleep 30 & echo $! > "$0.tmp"; mv "$0.tmp" "$0"; wait', pidFile], upload: ['true'], remove: ['true'] })
    const kill = process.kill.bind(process)
    const raised: (string | number | undefined)[] = []
    vi.spyOn(process, 'kill').mockImplementation((pid, name) => {
      if (pid === process.pid) {
        raised.push(name)
        return true
      }
      return kill(pid, name)
    })
    const stopping = vi.fn()
    process.once('SIGTERM', stopping)
    const download = backend.download('a.gz', { signal: new AbortController().signal })
    const sleeper = await pidOf(pidFile)
    process.emit('SIGTERM', 'SIGTERM')

    await expect(download).rejects.toThrow('download of shared failed')
    expect(() => kill(sleeper, 0)).toThrow()
    expect(stopping).toHaveBeenCalledOnce()
    expect(raised).toEqual([])
  }, 10_000)

  it('kills every cancellable command and the processes they started as the devtool exits, with one listener', async () => {
    const backend = backendOf({ list: ['true'], download: ['bash', '-c', 'trap "" TERM INT; sleep 30 & echo $! > "$0.tmp"; mv "$0.tmp" "$0"; wait', '%{ADT:PATH}'], upload: ['true'], remove: ['true'] })
    const exits = process.listeners('exit')
    const stops = process.listenerCount('SIGTERM')
    const pidFiles = [1, 2, 3].map(index => path.join(folder, `started-${index}`))
    const outcomes = pidFiles.map(async pidFile => backend.download(pidFile, { signal: new AbortController().signal }).then(() => 'downloaded', (error: unknown) => (error as Error).message))
    const sleepers = await Promise.all(pidFiles.map(async pidFile => pidOf(pidFile)))
    expect(process.listeners('exit')).toHaveLength(exits.length + 1)
    expect(process.listenerCount('SIGTERM')).toBe(stops + 1)
    for (const listener of process.listeners('exit').filter(candidate => !exits.includes(candidate))) {
      (listener as () => void)()
    }

    for (const outcome of await Promise.all(outcomes)) {
      expect(outcome).toMatch(/^download of shared failed/)
    }
    await vi.waitFor(() => {
      for (const sleeper of sleepers) {
        expect(() => process.kill(sleeper, 0)).toThrow()
      }
    })
    expect(process.listeners('exit')).toEqual(exits)
    expect(process.listenerCount('SIGTERM')).toBe(stops)
  }, 10_000)

  it('ends a stopped command once it exits, though a process that left its group keeps its output open', async () => {
    const pidFile = path.join(folder, 'escaped')
    const escape = `perl -MPOSIX -e 'POSIX::setsid(); open(my $f, ">", "$ARGV[0].tmp"); print $f $$; close $f; rename("$ARGV[0].tmp", $ARGV[0]); sleep 8' "$0" & wait`
    const backend = backendOf({ list: ['true'], download: ['true'], upload: ['bash', '-c', escape, pidFile], remove: ['true'] })
    const cancel = new AbortController()
    const upload = backend.upload('a.gz', await localFile('a.gz', 'content'), 'application/gzip', { signal: cancel.signal })
    await pidOf(pidFile)
    const started = Date.now()
    cancel.abort(new Error('cancelled'))

    try {
      await expect(upload).rejects.toThrow('upload of shared stopped')
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      await killLeft(pidFile)
    }
  }, 15_000)

  it('ends a command once it exits, though a process that left its group keeps its output open', async () => {
    const pidFile = path.join(folder, 'escaped')
    const escape = `perl -MPOSIX -e 'POSIX::setsid(); open(my $f, ">", "$ARGV[0].tmp"); print $f $$; close $f; rename("$ARGV[0].tmp", $ARGV[0]); sleep 8' "$0" & sleep 0.3; echo '{"files":[]}'`
    const backend = backendOf({ list: ['bash', '-c', escape, pidFile], download: ['true'], upload: ['true'], remove: ['true'] })
    const started = Date.now()

    try {
      expect(await backend.list()).toEqual([])
      expect(Date.now() - started).toBeLessThan(3000)
    } finally {
      await killLeft(pidFile)
    }
  }, 15_000)

  it('ends a command cancelled once it exited as it ended, not as stopped', async () => {
    const pidFile = path.join(folder, 'escaped')
    const escape = `perl -MPOSIX -e 'POSIX::setsid(); open(my $f, ">", "$ARGV[0].tmp"); print $f $$; close $f; rename("$ARGV[0].tmp", $ARGV[0]); sleep 5' "$0" & sleep 0.2; exit 0`
    const backend = backendOf({ list: ['true'], download: ['true'], upload: ['bash', '-c', escape, pidFile], remove: ['true'] })
    const cancel = new AbortController()
    setTimeout(() => cancel.abort(new Error('cancelled')), 600)

    try {
      await backend.upload('a.gz', await localFile('a.gz', 'content'), 'application/gzip', { signal: cancel.signal })
    } finally {
      await killLeft(pidFile)
    }
  }, 15_000)

  it('kills what a command left running in its group once it ends', async () => {
    const pidFile = path.join(folder, 'left')
    const backend = backendOf({ list: ['true'], download: ['true'], upload: ['bash', '-c', 'sleep 300 > /dev/null 2>&1 & echo $! > "$0.tmp"; mv "$0.tmp" "$0"', pidFile], remove: ['true'] })

    await backend.upload('a.gz', await localFile('a.gz', 'content'), 'application/gzip')
    const left = await pidOf(pidFile)
    await vi.waitFor(() => {
      expect(() => process.kill(left, 0)).toThrow()
    })
  }, 10_000)

  it('runs every command in a group of its own that the stop signals of the devtool reach', async () => {
    const pidFile = path.join(folder, 'started')
    const backend = backendOf({ list: ['true'], download: ['true'], upload: ['true'], remove: ['bash', '-c', 'sleep 30 & echo $! > "$0.tmp"; mv "$0.tmp" "$0"; wait', pidFile] })
    const stopping = vi.fn()
    process.once('SIGTERM', stopping)
    const removal = backend.remove('a.gz')
    const sleeper = await pidOf(pidFile)
    process.emit('SIGTERM', 'SIGTERM')

    await expect(removal).rejects.toThrow('remove of shared failed')
    await vi.waitFor(() => {
      expect(() => process.kill(sleeper, 0)).toThrow()
    })
  }, 10_000)

  it('counts the progress lines of the download command as bytes received', async () => {
    const backend = backendOf({
      list: ['true'],
      download: ['bash', '-c', 'echo "progress: 5" >&2; sleep 0.3; printf abcdef > "$0"', '%{ADT:FILE}'],
      upload: ['true'],
      remove: ['true']
    })
    const received = progressRecorder()
    expect(await textOf(await backend.download('a.gz', { onProgress: received.onProgress }))).toBe('abcdef')
    expect(received.reports).toContainEqual([5, null])
    expect(received.reports.at(-1)).toEqual([6, null])
  })

  it('reads the value blocks once, before any command runs', async () => {
    const resolve = vi.fn(async (text: string) => text)
    const { options } = scripts.readOptions({ list: ['bash', '-c', 'echo \'{"files":[]}\''], download: ['true'], upload: ['true'], remove: ['true'], env: { TOKEN: 'x' } }, sharedOf(), 'environment.backends.shared')
    const backend = scripts.create(options!, { ...contextOf(), resolve })

    await backend.prepare!()
    const read = resolve.mock.calls.length
    await backend.list()
    await backend.list()
    expect(resolve).toHaveBeenCalledTimes(read)
  })

  it('cancels an upload while the developer approves the reading of its value blocks', async () => {
    const resolve = vi.fn(async (text: string) => (text === 'upload-secret' ? new Promise<string>(() => {}) : text))
    const { options } = scripts.readOptions({ list: ['true'], download: ['true'], upload: ['true', 'upload-secret'], remove: ['true'] }, sharedOf(), 'environment.backends.shared')
    const backend = scripts.create(options!, { ...contextOf(), resolve })
    const cancel = new AbortController()
    setTimeout(() => cancel.abort(new Error('cancelled')), 200)
    await fs.writeFile(path.join(folder, 'a.gz'), 'archive')

    await expect(backend.upload('a.gz', path.join(folder, 'a.gz'), 'application/gzip', { signal: cancel.signal })).rejects.toThrow('cancelled')
  })

  it('reads the value blocks of the upload and remove commands only when they run', async () => {
    const resolve = vi.fn(async (text: string) => text)
    const { options } = scripts.readOptions({ list: ['bash', '-c', 'echo \'{"files":[]}\''], download: ['true'], upload: ['true', 'upload-secret'], remove: ['true', 'remove-secret'] }, sharedOf(), 'environment.backends.shared')
    const backend = scripts.create(options!, { ...contextOf(), resolve })

    await backend.prepare!()
    await backend.list()
    expect(resolve.mock.calls.flat()).not.toContain('upload-secret')
    expect(resolve.mock.calls.flat()).not.toContain('remove-secret')
    await backend.remove('a.gz')
    expect(resolve.mock.calls.flat()).toContain('remove-secret')
    expect(resolve.mock.calls.flat()).not.toContain('upload-secret')
  })

  it('stops the upload command its signal cancels, with the processes it started', async () => {
    const pidFile = path.join(folder, 'started')
    const backend = backendOf({ list: ['true'], download: ['true'], upload: ['bash', '-c', 'echo "progress: 1" >&2; sleep 30 & echo $! > "$0.tmp"; mv "$0.tmp" "$0"; wait', pidFile], remove: ['true'] })
    const cancel = new AbortController()
    const upload = backend.upload('a.gz', await localFile('a.gz', 'content'), 'application/gzip', { signal: cancel.signal })
    const sleeper = await pidOf(pidFile)
    cancel.abort(new Error('cancelled'))

    await expect(upload).rejects.toThrow(PossiblyStoredError)
    await expect(upload).rejects.toThrow('upload of shared stopped')
    await vi.waitFor(() => {
      expect(() => process.kill(sleeper, 0)).toThrow()
    })
  }, 10_000)

  it('needs upload and remove commands unless the backend refuses every push', async () => {
    const commands = { list: ['true'], download: ['true'] }
    expect(scripts.readOptions(commands, sharedOf(), 'environment.backends.shared').problems.map(problem => problem.setting)).toEqual([
      'environment.backends.shared.upload',
      'environment.backends.shared.remove'
    ])

    const { options, problems } = scripts.readOptions(commands, sharedOf({ pull: null, push: false }), 'environment.backends.shared')
    expect(problems).toEqual([])
    expect(options).toMatchObject({ upload: null, remove: null })
    await expect(scripts.create(options!, contextOf()).upload('a.yml', '/dev/null', 'application/yaml')).rejects.toThrow('shared declares no upload command')
  })
})
