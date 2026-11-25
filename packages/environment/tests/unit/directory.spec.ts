import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeLocalFile } from '../../src/directory.js'

let folder: string

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-directory-'))
})

afterEach(async () => {
  await fs.rm(folder, { recursive: true, force: true })
})

describe('writeLocalFile', () => {
  it('writes a stream, leaving no partial file', async () => {
    await writeLocalFile(path.join(folder, 'a/b.txt'), Readable.from([Buffer.from('hello')]))
    expect(await fs.readFile(path.join(folder, 'a/b.txt'), 'utf-8')).toBe('hello')
    expect(await fs.readdir(path.join(folder, 'a'))).toEqual(['b.txt'])
  })

  it('closes the stream when the file cannot be written', async () => {
    await fs.writeFile(path.join(folder, 'blocker'), '')
    const content = Readable.from([Buffer.from('hello')])
    await expect(writeLocalFile(path.join(folder, 'blocker/b.txt'), content)).rejects.toThrow()
    expect(content.destroyed).toBe(true)
  })
})
