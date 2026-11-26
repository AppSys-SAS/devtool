import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withFileLock, writeLocalFile } from '../../src/directory.js'

let folder: string

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-directory-'))
})

afterEach(async () => {
  await fs.rm(folder, { recursive: true, force: true })
})

describe('withFileLock', () => {
  it('runs the task holding the lock, then releases it, even when the task fails', async () => {
    const lockPath = path.join(folder, 'api/db.gz.lock')
    expect(await withFileLock(lockPath, 'api/db.gz', async () => fs.readFile(lockPath, 'utf-8'))).toBe(String(process.pid))
    await expect(withFileLock(lockPath, 'api/db.gz', async () => Promise.reject(new Error('refused')))).rejects.toThrow('refused')
    expect(await fs.readdir(path.join(folder, 'api'))).toEqual([])
  })

  it.each([
    ['another running process', String(process.ppid), `in use by another process (${process.ppid})`],
    ['a process still writing it', '', 'in use by another process']
  ])('refuses the task while %s holds the lock, naming the lock to remove', async (_case, holder, refusal) => {
    const lockPath = path.join(folder, 'db.gz.lock')
    await fs.writeFile(lockPath, holder)
    let ran = false
    const task = async (): Promise<void> => {
      ran = true
    }
    const message = await withFileLock(lockPath, 'api/db.gz', task).then(() => '', (error: Error) => error.message)
    expect([message, ran, await fs.readFile(lockPath, 'utf-8')]).toEqual([`api/db.gz is ${refusal}: try again once it ends, or remove ${lockPath} if none runs`, false, holder])
  })

  it('refuses a second task of this process while the first holds the lock, without advising to remove it', async () => {
    const lockPath = path.join(folder, 'db.gz.lock')
    let release = (): void => undefined
    let started = (): void => undefined
    const running = new Promise<void>(resolve => {
      started = resolve
    })
    const first = withFileLock(lockPath, 'api/db.gz', async () => {
      started()
      await new Promise<void>(resolve => {
        release = resolve
      })
    })
    await running
    await expect(withFileLock(lockPath, 'api/db.gz', async () => 'second')).rejects.toThrow(/^api\/db\.gz is being transferred: try again once it ends$/)

    release()
    await first
    expect(await withFileLock(lockPath, 'api/db.gz', async () => 'third')).toBe('third')
  })

  it.each([
    ['a process that no longer runs', () => String(spawnSync(process.execPath, ['-e', '0']).pid)],
    ['an earlier process of the identifier of this one', () => String(process.pid)]
  ])('takes over a lock left by %s', async (_case, holder) => {
    const lockPath = path.join(folder, 'db.gz.lock')
    await fs.writeFile(lockPath, holder())

    expect(await withFileLock(lockPath, 'api/db.gz', async () => 'done')).toBe('done')
    await expect(fs.access(lockPath)).rejects.toThrow()
  })
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
