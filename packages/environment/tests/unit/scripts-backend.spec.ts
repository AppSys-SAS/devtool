import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendContext, EnvironmentBackend } from '../../src/backends/backend.js'
import { scripts } from '../../src/backends/scripts.js'

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
 * Creates a scripts backend from raw settings.
 * @param settings - The raw settings of the backend.
 * @returns The backend.
 */
function backendOf (settings: Record<string, unknown>): EnvironmentBackend {
  const { options, problems } = scripts.readOptions(settings, { type: 'scripts', slug: 'shared', default: true, encryption: null }, 'environment.backends.shared')
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
  })

  it('reads the value blocks of the arguments and of the environment, and defaults the version to the date', async () => {
    const context: BackendContext = { ...contextOf(), resolve: async text => text.replace('{{ secret }}', 's3cr3t') }
    const { options } = scripts.readOptions({
      list: ['bash', '-c', 'printf \'{"files":[{"path":"%s","size":1,"updatedAt":"2026-01-02T03:04:05Z"}]}\' "$TOKEN-$0"', '{{ secret }}'],
      download: ['true'],
      upload: ['true'],
      remove: ['true'],
      env: { TOKEN: '{{ secret }}' }
    }, { type: 'scripts', slug: 'shared', default: true, encryption: null }, 'environment.backends.shared')
    const files = await scripts.create(options!, context).list()
    expect(files).toEqual([{ path: 's3cr3t-s3cr3t', size: 1, updatedAt: new Date('2026-01-02T03:04:05Z'), version: '2026-01-02T03:04:05.000Z' }])
  })
})
