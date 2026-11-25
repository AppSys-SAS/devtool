import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { databaseEngine, splitPostgresName } from '../../src/engines.js'

let folder: string

/**
 * Reads the arguments the fake docker command was called with.
 * @returns The arguments of each call.
 */
async function dockerCalls (): Promise<string[][]> {
  const log = await fs.readFile(path.join(folder, 'calls'), 'utf-8').catch(() => '')
  return log.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as string[])
}

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-engines-'))
  const docker = path.join(folder, 'docker')
  await fs.writeFile(docker, `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(path.join(folder, 'calls'))}, JSON.stringify(process.argv.slice(2)) + '\\n')
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
`, { mode: 0o755 })
  vi.stubEnv('PATH', `${folder}${path.delimiter}${process.env.PATH ?? ''}`)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fs.rm(folder, { recursive: true, force: true })
})

describe('splitPostgresName', () => {
  it('splits and unquotes a schema.table name', () => {
    expect(splitPostgresName('public.users')).toEqual({ schema: 'public', table: 'users' })
    expect(splitPostgresName('"My Schema"."Order.Lines"')).toEqual({ schema: 'My Schema', table: 'Order.Lines' })
    expect(splitPostgresName('public."say ""hi"""')).toEqual({ schema: 'public', table: 'say "hi"' })
    expect(() => splitPostgresName('users')).toThrow('not a schema.table name: users')
  })
})

describe('database targets', () => {
  it('passes the database of the item to the container, and nothing for the default one of the image', async () => {
    const mongodb = databaseEngine('mongodb')
    await mongodb.restoreNative({ container: 'mongo', database: 'catalog' }, Readable.from([Buffer.from('archive')]), ['users'])
    await mongodb.restoreNative({ container: 'mongo', database: null }, Readable.from([Buffer.from('archive')]), null)

    const [named, unnamed] = await dockerCalls()
    expect(named.slice(0, 4)).toEqual(['exec', '-i', '-e', 'ADT_DATABASE=catalog'])
    expect(named[4]).toBe('mongo')
    expect(named[7]).toContain('mongorestore --quiet --archive --gzip --drop')
    expect(named.slice(-2)).toEqual(['--nsInclude', '*.users'])
    expect(unnamed.slice(0, 3)).toEqual(['exec', '-i', 'mongo'])
    expect(unnamed[unnamed.length - 1]).toBe('sh')
  })

  it('restores some postgres tables from a native archive as rows only, each schema and table given apart', async () => {
    await databaseEngine('postgres').restoreNative({ container: 'pg', database: null }, Readable.from([Buffer.from('archive')]), ['public.users', '"Sales"."Orders"'])

    const [call] = await dockerCalls()
    expect(call.slice(call.indexOf('sh', 4) + 1)).toEqual([
      'DELETE FROM public.users; DELETE FROM "Sales"."Orders";',
      '-n', 'public', '-t', 'users',
      '-n', 'Sales', '-t', 'Orders'
    ])
    expect(call.find(arg => arg.includes('pg_restore'))).toContain('--data-only')
  })

  it('refuses to restore some tables of a native mariadb archive', async () => {
    await expect(databaseEngine('mariadb').restoreNative({ container: 'db', database: null }, Readable.from([]), ['users'])).rejects.toThrow('restores the whole database only')
    expect(await dockerCalls()).toEqual([])
  })
})
