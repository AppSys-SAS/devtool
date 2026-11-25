import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readTar, type TarEntry, writeTar } from '../../src/tar.js'

const LONG_NAME = `${'nested/'.repeat(20)}photo.png`
const hasTar = ((): boolean => {
  try {
    execFileSync('tar', ['--version'])
    return true
  } catch {
    return false
  }
})()

let folder: string

/**
 * Builds files to archive.
 * @param files - The content of each file, by name.
 * @returns The entries.
 */
async function* entriesOf (files: Record<string, string>): AsyncGenerator<TarEntry> {
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content)
    yield { name, size: body.length, body: Readable.from([body]) }
  }
}

/**
 * Reads every file of an archive.
 * @param archive - The uncompressed archive.
 * @returns The content of each file, by name.
 */
async function filesOf (archive: AsyncIterable<Buffer>): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for await (const { name, body } of readTar(archive)) {
    const chunks: Buffer[] = []
    for await (const chunk of body) {
      chunks.push(chunk)
    }
    files[name] = Buffer.concat(chunks).toString('utf-8')
  }
  return files
}

/**
 * Collects a stream into one buffer.
 * @param stream - The stream.
 * @returns Its bytes.
 */
async function bytesOf (stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Builds a ustar header block.
 * @param name - The path.
 * @param size - The size of the body, as written in the header.
 * @param type - The entry type.
 * @returns The header block.
 */
function rawHeader (name: string, size: number | string, type: string): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  header.write(typeof size === 'number' ? `${size.toString(8).padStart(11, '0')}\0` : size, 124, 12)
  header.write(type, 156, 1)
  header.write('ustar\u000000', 257, 8)
  let sum = 0
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index]
  }
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return header
}

/**
 * Builds an entry: its header and its body padded to whole blocks.
 * @param name - The path.
 * @param type - The entry type.
 * @param body - The body.
 * @returns The entry bytes.
 */
function rawEntry (name: string, type: string, body: string): Buffer {
  const bytes = Buffer.from(body)
  return Buffer.concat([rawHeader(name, bytes.length, type), bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)])
}

/**
 * Builds a PAX record, its length counting itself.
 * @param key - The key.
 * @param value - The value.
 * @returns The record.
 */
function paxRecord (key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  const length = String(body.length + 3).length + body.length
  return `${length}${body}`
}

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-tar-'))
})

afterEach(async () => {
  await fs.rm(folder, { recursive: true, force: true })
})

describe('tar archives', () => {
  it('reads back what it writes, long and nested names included', async () => {
    const files = { 'a.txt': 'alpha', 'docs/b.json': '{"b":1}', [LONG_NAME]: 'x'.repeat(70_000), 'empty.bin': '' }
    expect(await filesOf(writeTar(entriesOf(files)))).toEqual(files)
  })

  it('ends with two empty blocks and pads every body to whole blocks', async () => {
    const archive = await bytesOf(writeTar(entriesOf({ 'a.txt': 'alpha' })))
    expect(archive.length).toBe(512 * 4)
    expect(archive.subarray(-1024).every(byte => byte === 0)).toBe(true)
  })

  it('fails when a body does not hold its announced size', async () => {
    const entries = (async function* (): AsyncGenerator<TarEntry> {
      yield { name: 'a.txt', size: 10, body: Readable.from([Buffer.from('short')]) }
    })()
    await expect(bytesOf(writeTar(entries))).rejects.toThrow()
  })

  it('keeps names that start with ./ or end with /, such as folder markers', async () => {
    const files = { './hidden.txt': 'a', 'hidden.txt': 'b', 'photos/': '' }
    expect(await filesOf(writeTar(entriesOf(files)))).toEqual(files)
  })

  it('reads an archive holding no file, and refuses one without any block', async () => {
    expect(await filesOf(writeTar(entriesOf({})))).toEqual({})
    await expect(filesOf(Readable.from([]))).rejects.toThrow('not a tar archive')
  })

  it('refuses sparse files and entries of an unknown type rather than storing their raw bytes', async () => {
    const pax = Buffer.concat([rawEntry('PaxHeader', 'x', paxRecord('GNU.sparse.name', 'disk.img') + paxRecord('GNU.sparse.major', '1')), rawEntry('GNUSparseFile.0/disk.img', '0', 'map'), Buffer.alloc(1024)])
    await expect(filesOf(Readable.from([pax]))).rejects.toThrow('is a sparse file')
    await expect(filesOf(Readable.from([Buffer.concat([rawEntry('disk.img', 'S', ''), Buffer.alloc(1024)])]))).rejects.toThrow('disk.img is an entry of an unknown type')
  })

  it('refuses what is not a tar archive', async () => {
    await expect(filesOf(Readable.from([Buffer.alloc(512, 'x')]))).rejects.toThrow()
  })

  it.skipIf(!hasTar)('reads the regular files of an archive of the tar command, without leading ./ nor folders', async () => {
    const source = path.join(folder, 'source')
    await fs.mkdir(path.join(source, path.dirname(LONG_NAME)), { recursive: true })
    await fs.writeFile(path.join(source, 'a.txt'), 'alpha')
    await fs.writeFile(path.join(source, LONG_NAME), 'deep')
    const archive = path.join(folder, 'objects.tar')
    execFileSync('tar', ['-cf', archive, '-C', source, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })

    expect(await filesOf(Readable.from([await fs.readFile(archive)]))).toEqual({ 'a.txt': 'alpha', [LONG_NAME]: 'deep' })
  })

  it.skipIf(!hasTar)('writes archives the tar command extracts', async () => {
    const archive = path.join(folder, 'objects.tar')
    await fs.writeFile(archive, await bytesOf(writeTar(entriesOf({ 'a.txt': 'alpha', [LONG_NAME]: 'deep' }))))
    const target = path.join(folder, 'target')
    await fs.mkdir(target)
    execFileSync('tar', ['-xf', archive, '-C', target])

    expect(await fs.readFile(path.join(target, 'a.txt'), 'utf-8')).toBe('alpha')
    expect(await fs.readFile(path.join(target, LONG_NAME), 'utf-8')).toBe('deep')
  })
})
