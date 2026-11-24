import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installLego, LEGO_VERSION, legoArchive, verifyArchive } from '../../src/lego.js'

const execFileAsync = promisify(execFile)

const processDescriptors = {
  platform: Object.getOwnPropertyDescriptor(process, 'platform')!,
  arch: Object.getOwnPropertyDescriptor(process, 'arch')!
}

const supportedArchives = [
  ['darwin', 'arm64', `lego_v${LEGO_VERSION}_darwin_arm64.tar.gz`],
  ['darwin', 'x64', `lego_v${LEGO_VERSION}_darwin_amd64.tar.gz`],
  ['linux', 'x64', `lego_v${LEGO_VERSION}_linux_amd64.tar.gz`],
  ['linux', 'arm64', `lego_v${LEGO_VERSION}_linux_arm64.tar.gz`]
]

/**
 * Makes the running process report another platform and processor.
 * @param platform - The platform `process.platform` reports.
 * @param arch - The processor `process.arch` reports.
 */
function emulateProcess (platform: string, arch: string): void {
  Object.defineProperty(process, 'platform', { ...processDescriptors.platform, value: platform })
  Object.defineProperty(process, 'arch', { ...processDescriptors.arch, value: arch })
}

/**
 * Gives the SHA-256 of some content.
 * @param content - The content to hash.
 * @returns The SHA-256, in hexadecimal.
 */
function sha256Of (content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Replaces `fetch` with a mock answering every request with the same outcome.
 * @param answer - Produces the response of each request.
 * @returns The mock standing for `fetch`.
 */
function stubFetch (answer: () => Promise<Response>) {
  const fetchMock = vi.fn(answer)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * Gives the response of a failed download.
 * @returns A 404 response.
 */
async function notFound (): Promise<Response> {
  return new Response('missing', { status: 404, statusText: 'Not Found' })
}

/**
 * Builds a gzipped tar archive holding an executable `lego` script.
 * @param root - The folder in which the archive is built.
 * @returns The content of the archive.
 */
async function buildArchive (root: string): Promise<Buffer> {
  const source = await fs.mkdtemp(path.join(root, 'source-'))
  await fs.writeFile(path.join(source, 'lego'), '#!/bin/sh\necho lego\n', { mode: 0o755 })
  const archive = path.join(root, 'lego.tar.gz')
  await execFileAsync('tar', ['-czf', archive, '-C', source, 'lego'])
  return fs.readFile(archive)
}

/**
 * Places a lego executable of the current version in a folder of versions.
 * @param folder - The folder holding one subfolder per version of lego.
 * @param mode - The permissions of the executable.
 * @returns The path of the executable.
 */
async function placeExecutable (folder: string, mode = 0o755): Promise<string> {
  const executable = path.join(folder, LEGO_VERSION, 'lego')
  await fs.mkdir(path.dirname(executable), { recursive: true })
  await fs.writeFile(executable, '#!/bin/sh\n', { mode })
  await fs.chmod(executable, mode)
  return executable
}

/**
 * Tells whether a path exists.
 * @param target - The path to check.
 * @returns Whether something exists at the path.
 */
async function exists (target: string): Promise<boolean> {
  return fs.access(target).then(() => true, () => false)
}

afterEach(() => {
  Object.defineProperty(process, 'platform', processDescriptors.platform)
  Object.defineProperty(process, 'arch', processDescriptors.arch)
  vi.unstubAllGlobals()
})

describe('LEGO_VERSION', () => {
  it('is a plain semantic version', () => {
    expect(LEGO_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('legoArchive', () => {
  it.each(supportedArchives)('gives the archive of %s-%s', (platform, arch, file) => {
    const archive = legoArchive(platform, arch)
    expect(archive.file).toBe(file)
    expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('gives a distinct checksum to each archive', () => {
    const checksums = supportedArchives.map(([platform, arch]) => legoArchive(platform, arch).sha256)
    expect(new Set(checksums).size).toBe(supportedArchives.length)
  })

  it('defaults to the platform and processor of the running process', () => {
    emulateProcess('linux', 'arm64')
    expect(legoArchive()).toEqual(legoArchive('linux', 'arm64'))
    emulateProcess('darwin', 'x64')
    expect(legoArchive()).toEqual(legoArchive('darwin', 'x64'))
  })

  it.each([
    ['win32', 'x64'],
    ['darwin', 'ia32'],
    ['linux', 'arm'],
    ['freebsd', 'x64'],
    ['Linux', 'x64'],
    ['linux', 'amd64']
  ])('refuses %s-%s', (platform, arch) => {
    expect(() => legoArchive(platform, arch)).toThrow(`lego is not available for ${platform}-${arch}`)
  })

  it('refuses an unsupported running platform', () => {
    emulateProcess('win32', 'arm64')
    expect(() => legoArchive()).toThrow('lego is not available for win32-arm64')
  })

  it('refuses an unsupported platform and lists the supported ones', () => {
    expect(() => legoArchive('win32', 'x64')).toThrow('lego is not available for win32-x64 (supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64)')
  })
})

describe('verifyArchive', () => {
  const content = Buffer.from('archive')
  const sha256 = sha256Of(content)

  it('accepts the expected archive', () => {
    expect(() => verifyArchive(content, sha256)).not.toThrow()
  })

  it('accepts an empty archive matching its checksum', () => {
    const empty = Buffer.alloc(0)
    expect(() => verifyArchive(empty, sha256Of(empty))).not.toThrow()
  })

  it('refuses another archive, naming both checksums', () => {
    const other = Buffer.from('other')
    expect(() => verifyArchive(other, sha256)).toThrow(`the lego archive does not match its checksum (expected ${sha256}, got ${sha256Of(other)})`)
  })

  it('refuses a truncated archive', () => {
    expect(() => verifyArchive(content.subarray(0, -1), sha256)).toThrow(`expected ${sha256}`)
  })

  it('refuses an empty archive', () => {
    expect(() => verifyArchive(Buffer.alloc(0), sha256)).toThrow(`got ${sha256Of(Buffer.alloc(0))}`)
  })
})

describe('installLego', () => {
  let root: string
  let folder: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'lego-spec-'))
    folder = path.join(root, 'lego')
    emulateProcess('linux', 'x64')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('gives the installed executable without downloading it', async () => {
    const executable = await placeExecutable(folder)
    const fetchMock = stubFetch(notFound)
    const log = vi.fn()

    await expect(installLego(folder, log)).resolves.toBe(executable)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('removes the other versions and leftovers of the folder', async () => {
    const executable = await placeExecutable(folder)
    await fs.mkdir(path.join(folder, '5.5.0'))
    await fs.writeFile(path.join(folder, '5.5.0', 'lego'), '#!/bin/sh\n', { mode: 0o755 })
    await fs.mkdir(path.join(folder, `.${LEGO_VERSION}-abc123`))
    await fs.writeFile(path.join(folder, 'stray'), 'stray')
    stubFetch(notFound)

    await installLego(folder)

    expect(await fs.readdir(folder)).toEqual([LEGO_VERSION])
    expect(await exists(executable)).toBe(true)
  })

  it('downloads the release of the platform when the executable is not executable', async () => {
    await placeExecutable(folder, 0o644)
    const fetchMock = stubFetch(notFound)
    const file = `lego_v${LEGO_VERSION}_linux_amd64.tar.gz`
    const url = `https://github.com/go-acme/lego/releases/download/v${LEGO_VERSION}/${file}`
    const log = vi.fn()

    await expect(installLego(folder, log)).rejects.toThrow(`lego download failed: 404 Not Found (${url})`)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(url)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(`Downloading lego ${LEGO_VERSION} (${file})`)
  })

  it('downloads the release when the folder is missing', async () => {
    const fetchMock = stubFetch(notFound)

    await expect(installLego(folder)).rejects.toThrow('lego download failed: 404 Not Found')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await exists(folder)).toBe(false)
  })

  it('reports a download that cannot reach the server', async () => {
    stubFetch(async () => {
      throw new Error('getaddrinfo ENOTFOUND github.com')
    })

    await expect(installLego(folder)).rejects.toThrow('getaddrinfo ENOTFOUND github.com')
    expect(await exists(folder)).toBe(false)
  })

  it('refuses an archive that does not match its checksum and leaves nothing behind', async () => {
    const archive = await buildArchive(root)
    stubFetch(async () => new Response(new Uint8Array(archive)))
    const log = vi.fn()

    await expect(installLego(folder, log)).rejects.toThrow(`the lego archive does not match its checksum (expected ${legoArchive().sha256}, got ${sha256Of(archive)})`)
    expect(await exists(folder)).toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(`Downloading lego ${LEGO_VERSION} (${legoArchive().file})`)
  })

  it('refuses a mismatching archive without touching an existing folder', async () => {
    await fs.mkdir(path.join(folder, '5.5.0'), { recursive: true })
    const archive = await buildArchive(root)
    stubFetch(async () => new Response(new Uint8Array(archive)))

    await expect(installLego(folder)).rejects.toThrow('does not match its checksum')
    expect(await fs.readdir(folder)).toEqual(['5.5.0'])
  })

  it('refuses an unsupported platform without downloading', async () => {
    emulateProcess('win32', 'x64')
    const fetchMock = stubFetch(notFound)

    await expect(installLego(folder)).rejects.toThrow('lego is not available for win32-x64')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shares the installation of concurrent calls on the same folder', async () => {
    const executable = await placeExecutable(folder)
    stubFetch(notFound)

    const first = installLego(folder)
    const second = installLego(folder)

    expect(second).toBe(first)
    await expect(Promise.all([first, second])).resolves.toEqual([executable, executable])
  })

  it('shares a failing download between concurrent calls', async () => {
    const fetchMock = stubFetch(notFound)

    const first = installLego(folder)
    const second = installLego(folder)

    await expect(first).rejects.toThrow('lego download failed')
    await expect(second).rejects.toThrow('lego download failed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('starts a new installation once the previous one has settled', async () => {
    const executable = await placeExecutable(folder)
    stubFetch(notFound)

    const first = installLego(folder)
    await expect(first).resolves.toBe(executable)
    const second = installLego(folder)

    expect(second).not.toBe(first)
    await expect(second).resolves.toBe(executable)
  })

  it('retries the download after a failed installation', async () => {
    const fetchMock = stubFetch(notFound)

    await expect(installLego(folder)).rejects.toThrow('lego download failed')
    await expect(installLego(folder)).rejects.toThrow('lego download failed')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives the absolute path of the executable for a folder relative to the working directory', async () => {
    const executable = await placeExecutable(folder)
    const relativeFolder = path.relative(process.cwd(), folder)
    stubFetch(notFound)

    expect(path.isAbsolute(relativeFolder)).toBe(false)
    const installed = await installLego(relativeFolder)
    expect(path.isAbsolute(installed)).toBe(true)
    expect(installed).toBe(executable)
  })

  it('shares the installation of a folder written relative and absolute', async () => {
    const executable = await placeExecutable(folder)
    stubFetch(notFound)

    const first = installLego(path.relative(process.cwd(), folder))
    const second = installLego(folder)
    const third = installLego(`${folder}/../lego/.`)

    expect(second).toBe(first)
    expect(third).toBe(first)
    await expect(first).resolves.toBe(executable)
  })

  it('does not share installations across folders', async () => {
    const otherFolder = path.join(root, 'other')
    const executable = await placeExecutable(folder)
    const otherExecutable = await placeExecutable(otherFolder)
    stubFetch(notFound)

    const first = installLego(folder)
    const second = installLego(otherFolder)

    expect(second).not.toBe(first)
    await expect(first).resolves.toBe(executable)
    await expect(second).resolves.toBe(otherExecutable)
  })
})
