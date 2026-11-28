import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scratchPath, withFileLock, writeLocalFile } from '../../src/directory.js'

let folder: string

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-directory-'))
})

afterEach(async () => {
  await fs.rm(folder, { recursive: true, force: true })
})

describe('withFileLock', () => {
  const ended = spawnSync(process.execPath, ['-e', '0']).pid

  it('runs the task holding the lock, then releases it, even when the task fails', async () => {
    const lockPath = path.join(folder, 'api/db.gz.lock')
    expect(await withFileLock(lockPath, 'api/db.gz', async () => fs.readFile(lockPath, 'utf-8'))).toBe(String(process.pid))
    await expect(withFileLock(lockPath, 'api/db.gz', async () => Promise.reject(new Error('refused')))).rejects.toThrow('refused')
    expect(await fs.readdir(path.join(folder, 'api'))).toEqual([])
  })

  it.each([
    ['another running process', String(process.ppid), `in use by another process (${process.ppid})`],
    ['a process still writing it', '', 'in use by another process'],
    ['a process that no longer runs', String(ended), `in use by another process (${ended})`],
    ['an earlier process of the identifier of this one', String(process.pid), `in use by another process (${process.pid})`]
  ])('refuses the task while a lock of %s is present, naming the lock to remove', async (_case, holder, refusal) => {
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
    await expect(withFileLock(lockPath, 'api/db.gz', async () => 'second')).rejects.toThrow(/^api\/db\.gz is in use: try again once it ends$/)

    release()
    await first
    expect(await withFileLock(lockPath, 'api/db.gz', async () => 'third')).toBe('third')
  })

  it('waits the given time for a lock another process holds, then runs the task', async () => {
    const lockPath = path.join(folder, 'sync.json.lock')
    await fs.writeFile(lockPath, String(process.ppid))
    setTimeout(() => {
      void fs.rm(lockPath)
    }, 150)

    expect(await withFileLock(lockPath, 'the journal', async () => fs.readFile(lockPath, 'utf-8'), 5_000)).toBe(String(process.pid))
    await fs.writeFile(lockPath, String(process.ppid))
    await expect(withFileLock(lockPath, 'the journal', async () => 'done', 100)).rejects.toThrow(`the journal is in use by another process (${process.ppid})`)
  })

  it('gives what the task did though its lock cannot be removed, the lock then refusing the next task', async () => {
    const locks = path.join(folder, 'locks')
    const lockPath = path.join(locks, 'db.gz.lock')
    try {
      expect(await withFileLock(lockPath, 'api/db.gz', async () => {
        await fs.chmod(locks, 0o500)
        return 'done'
      })).toBe('done')
      await expect(withFileLock(lockPath, 'api/db.gz', async () => 'again')).rejects.toThrow(`or remove ${lockPath} if none runs`)
    } finally {
      await fs.chmod(locks, 0o700)
    }
  })

  it('runs the task once a lock left behind is removed', async () => {
    const lockPath = path.join(folder, 'db.gz.lock')
    await fs.writeFile(lockPath, String(ended))
    await expect(withFileLock(lockPath, 'api/db.gz', async () => 'done')).rejects.toThrow(`or remove ${lockPath} if none runs`)

    await fs.rm(lockPath)
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

describe('scratchPath', () => {
  it('gives files of this process, removing first what processes no longer running left', async () => {
    const root = path.join(folder, 'environment', 'tmp')
    const ended = spawnSync(process.execPath, ['-e', '0']).pid
    await fs.mkdir(path.join(root, String(ended)), { recursive: true })
    await fs.writeFile(path.join(root, String(ended), 'copy.remote'), 'secret copy')
    await fs.mkdir(path.join(root, String(process.ppid)), { recursive: true })
    await fs.writeFile(path.join(root, String(process.ppid), 'copy.remote'), 'copy being read')

    const scratches = await Promise.all(Array.from({ length: 5 }, async () => {
      const scratch = await scratchPath(folder, 'remote')
      await fs.writeFile(scratch, 'copy')
      return scratch
    }))
    expect(scratches.every(scratch => path.dirname(scratch) === path.join(root, String(process.pid)) && scratch.endsWith('.remote'))).toBe(true)
    expect((await fs.readdir(root)).sort()).toEqual([String(process.pid), String(process.ppid)].sort())
    expect(await fs.readdir(path.join(root, String(process.pid)))).toHaveLength(5)
  })
})
