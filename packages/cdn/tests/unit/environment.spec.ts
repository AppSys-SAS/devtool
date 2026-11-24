import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type EnvironmentItem, type EnvironmentOptions, overwritesLocalData, parseTargets, readEnvironmentOptions, SHARED_CONFIG_PATH } from '../../src/environment.js'

const fileItem: EnvironmentItem = { kind: 'file', path: 'api/config.yml' }
const databaseItem: EnvironmentItem = { kind: 'database', path: 'api/db.gz', engine: 'postgres', container: 'postgres' }
const bucketItem: EnvironmentItem = { kind: 'bucket', path: 'api/s3.gz', bucket: 'uploads-dev' }
const redisItem: EnvironmentItem = { kind: 'redis', path: 'api/redis.gz', url: 'redis://localhost:6379/0' }

/**
 * Builds an environment made of the given items.
 *
 * @param items - The items of the environment.
 * @returns The environment, with no configuration file, auto pull nor S3 server.
 */
function environmentOf (items: EnvironmentItem[]): EnvironmentOptions {
  return { folder: '/example/env', items, configFiles: [], autoPulls: [], s3: null }
}

/**
 * Reads an `environment` section that is expected to be present.
 *
 * @param section - The raw section.
 * @returns The environment read from it.
 */
function read (section: unknown): EnvironmentOptions {
  const options = readEnvironmentOptions(section)
  if (!options) {
    throw new Error('the section was read as missing')
  }
  return options
}

describe('SHARED_CONFIG_PATH', () => {
  it('names the shared devtool configuration', () => {
    expect(SHARED_CONFIG_PATH).toBe('devtool/config.yml')
  })
})

describe('readEnvironmentOptions', () => {
  beforeEach(() => {
    vi.stubEnv('ADT_CONFIG_FOLDER', '/example/config/devtool')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('section', () => {
    it('gives null when the section is missing', () => {
      expect(readEnvironmentOptions(undefined)).toBeNull()
    })

    it('gives null when the section is null or not an object', () => {
      expect(readEnvironmentOptions(null)).toBeNull()
      expect(readEnvironmentOptions('devtool/config.yml')).toBeNull()
      expect(readEnvironmentOptions(42)).toBeNull()
      expect(readEnvironmentOptions(true)).toBeNull()
    })

    it('reads an empty section as an empty environment', () => {
      expect(readEnvironmentOptions({})).toEqual({
        folder: '/example/config',
        items: [],
        configFiles: [],
        autoPulls: [],
        s3: null
      })
    })

    it('reads the example of the documentation', () => {
      expect(readEnvironmentOptions({
        files: ['devtool/config.yml', 'api/config.yml', { path: 'devtool/docker-compose.yml', local: false }],
        databases: [{ path: 'api/db.gz', engine: 'postgres', container: 'postgres' }],
        buckets: [{ path: 'api/s3.gz', bucket: 'uploads-dev' }],
        s3: { endpoint: 'http://localhost:9000', accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' }
      })).toEqual({
        folder: '/example/config',
        items: [
          { kind: 'file', path: 'devtool/config.yml' },
          { kind: 'file', path: 'api/config.yml' },
          { kind: 'file', path: 'devtool/docker-compose.yml' },
          { kind: 'database', path: 'api/db.gz', engine: 'postgres', container: 'postgres' },
          { kind: 'bucket', path: 'api/s3.gz', bucket: 'uploads-dev' }
        ],
        configFiles: [
          { path: 'devtool/config.yml', display: true, local: true },
          { path: 'api/config.yml', display: true, local: true },
          { path: 'devtool/docker-compose.yml', display: true, local: false }
        ],
        autoPulls: [],
        s3: { endpoint: 'http://localhost:9000', accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin', region: 'us-east-1' }
      })
    })

    it('lists files, then databases, then buckets, then Redis databases', () => {
      const options = read({
        redis: [{ path: 'api/redis.gz', url: 'redis://localhost:6379/0' }],
        buckets: [{ path: 'api/s3.gz', bucket: 'uploads-dev' }],
        databases: [{ path: 'api/db.gz', engine: 'mariadb', container: 'mariadb' }],
        files: ['api/config.yml']
      })

      expect(options.items.map(item => item.kind)).toEqual(['file', 'database', 'bucket', 'redis'])
    })
  })

  describe('folder', () => {
    it('keeps the folder the section names', () => {
      expect(read({ folder: '/example/env' }).folder).toBe('/example/env')
    })

    it('defaults to the parent of the configuration folder named by ADT_CONFIG_FOLDER', () => {
      vi.stubEnv('ADT_CONFIG_FOLDER', '/example/other/devtool')

      expect(read({}).folder).toBe('/example/other')
    })

    it('defaults when the folder is not a string', () => {
      expect(read({ folder: 42 }).folder).toBe('/example/config')
      expect(read({ folder: null }).folder).toBe('/example/config')
    })

    it('trims ADT_CONFIG_FOLDER and expands its home folder', () => {
      vi.stubEnv('ADT_CONFIG_FOLDER', '  ~/example/devtool  ')

      expect(read({}).folder).toBe(path.join(os.homedir(), 'example'))
    })

    it('resolves a relative ADT_CONFIG_FOLDER against the working folder', () => {
      vi.stubEnv('ADT_CONFIG_FOLDER', 'example/devtool')

      expect(read({}).folder).toBe(path.resolve('example'))
    })

    it('defaults to ~/.config/appsys when ADT_CONFIG_FOLDER is empty or blank', () => {
      vi.stubEnv('ADT_CONFIG_FOLDER', '')
      expect(read({}).folder).toBe(path.join(os.homedir(), '.config', 'appsys'))

      vi.stubEnv('ADT_CONFIG_FOLDER', '   ')
      expect(read({}).folder).toBe(path.join(os.homedir(), '.config', 'appsys'))
    })

    it('defaults to ~/.config/appsys when ADT_CONFIG_FOLDER is unset', () => {
      vi.stubEnv('ADT_CONFIG_FOLDER', undefined)

      expect(read({}).folder).toBe(path.join(os.homedir(), '.config', 'appsys'))
    })
  })

  describe('files', () => {
    it('reads a path as a synchronized, displayed file with its local override', () => {
      const options = read({ files: ['api/config.yml'] })

      expect(options.items).toEqual([{ kind: 'file', path: 'api/config.yml' }])
      expect(options.configFiles).toEqual([{ path: 'api/config.yml', display: true, local: true }])
      expect(options.autoPulls).toEqual([])
    })

    it('defaults every flag of an object entry to true', () => {
      const options = read({ files: [{ path: 'api/config.yml' }] })

      expect(options.items).toEqual([{ kind: 'file', path: 'api/config.yml' }])
      expect(options.configFiles).toEqual([{ path: 'api/config.yml', display: true, local: true }])
    })

    it('keeps flags explicitly set to true', () => {
      const options = read({ files: [{ path: 'api/config.yml', display: true, local: true, sync: true }] })

      expect(options.items).toEqual([{ kind: 'file', path: 'api/config.yml' }])
      expect(options.configFiles).toEqual([{ path: 'api/config.yml', display: true, local: true }])
    })

    it('hides a file from the configurations tab with display: false', () => {
      const options = read({ files: [{ path: 'api/config.yml', display: false }] })

      expect(options.configFiles).toEqual([{ path: 'api/config.yml', display: false, local: true }])
      expect(options.items).toEqual([{ kind: 'file', path: 'api/config.yml' }])
    })

    it('leaves out the local override with local: false', () => {
      const options = read({ files: [{ path: 'api/config.yml', local: false }] })

      expect(options.configFiles).toEqual([{ path: 'api/config.yml', display: true, local: false }])
      expect(options.items).toEqual([{ kind: 'file', path: 'api/config.yml' }])
    })

    it('keeps a file with sync: false out of the synchronized items', () => {
      const options = read({ files: [{ path: 'devtool/config.local.yml', sync: false }, 'api/config.yml'] })

      expect(options.configFiles).toEqual([
        { path: 'devtool/config.local.yml', display: true, local: true },
        { path: 'api/config.yml', display: true, local: true }
      ])
      expect(options.items).toEqual([{ kind: 'file', path: 'api/config.yml' }])
    })

    it('ignores the pull of a file that is not synchronized', () => {
      const options = read({ files: [{ path: 'api/config.yml', sync: false, pull: { cron: '0 * * * *' } }] })

      expect(options.items).toEqual([])
      expect(options.autoPulls).toEqual([])
    })

    it('ignores files that are not a list', () => {
      expect(read({ files: 'api/config.yml' }).configFiles).toEqual([])
      expect(read({ files: { path: 'api/config.yml' } }).items).toEqual([])
    })

    it('rejects an entry without a string path', () => {
      expect(() => readEnvironmentOptions({ files: [{ display: false }] })).toThrow('invalid file in the environment: {"display":false}')
      expect(() => readEnvironmentOptions({ files: [{ path: 42 }] })).toThrow('invalid file in the environment: {"path":42}')
    })

    it('rejects an entry that is neither a path nor an object', () => {
      expect(() => readEnvironmentOptions({ files: [42] })).toThrow('invalid file in the environment: 42')
      expect(() => readEnvironmentOptions({ files: [null] })).toThrow('invalid file in the environment: null')
      expect(() => readEnvironmentOptions({ files: [['api/config.yml']] })).toThrow('invalid file in the environment: ["api/config.yml"]')
    })

    it.each(['display', 'local', 'sync'])('rejects a %s flag that is not a boolean', flag => {
      const file = { path: 'api/config.yml', [flag]: 'false' }

      expect(() => readEnvironmentOptions({ files: [file] })).toThrow(`invalid file in the environment: ${JSON.stringify(file)}`)
    })

    it('rejects a null flag', () => {
      expect(() => readEnvironmentOptions({ files: [{ path: 'api/config.yml', display: null }] })).toThrow('invalid file in the environment: {"path":"api/config.yml","display":null}')
    })
  })

  describe('pull', () => {
    it('reads a cron and a startup pull', () => {
      const options = read({ files: [{ path: 'api/config.yml', pull: { cron: '0 * * * *', startup: true } }] })

      expect(options.autoPulls).toEqual([{ path: 'api/config.yml', cron: '0 * * * *', startup: true }])
    })

    it('reads a cron pull alone', () => {
      const options = read({ files: [{ path: 'api/config.yml', pull: { cron: '*/5 * * * *' } }] })

      expect(options.autoPulls).toEqual([{ path: 'api/config.yml', cron: '*/5 * * * *', startup: false }])
    })

    it('reads a startup pull alone', () => {
      const options = read({ files: [{ path: 'api/config.yml', pull: { startup: true } }] })

      expect(options.autoPulls).toEqual([{ path: 'api/config.yml', cron: null, startup: true }])
    })

    it('reads a cron pull with startup: false', () => {
      const options = read({ files: [{ path: 'api/config.yml', pull: { cron: '0 0 * * *', startup: false } }] })

      expect(options.autoPulls).toEqual([{ path: 'api/config.yml', cron: '0 0 * * *', startup: false }])
    })

    it('adds no auto pull when the item is never pulled on its own', () => {
      expect(read({ files: [{ path: 'api/config.yml', pull: {} }] }).autoPulls).toEqual([])
      expect(read({ files: [{ path: 'api/config.yml', pull: { startup: false } }] }).autoPulls).toEqual([])
      expect(read({ files: [{ path: 'api/config.yml', pull: { cron: '', startup: false } }] }).autoPulls).toEqual([])
    })

    it('reads an empty or blank cron as none', () => {
      expect(read({ files: [{ path: 'api/config.yml', pull: { cron: '', startup: true } }] }).autoPulls).toEqual([{ path: 'api/config.yml', cron: null, startup: true }])
      expect(read({ files: [{ path: 'api/config.yml', pull: { cron: '  ', startup: true } }] }).autoPulls).toEqual([{ path: 'api/config.yml', cron: null, startup: true }])
      expect(read({ files: [{ path: 'api/config.yml', pull: { cron: '  ' } }] }).autoPulls).toEqual([])
    })

    it('still synchronizes an item whose pull is empty', () => {
      expect(read({ files: [{ path: 'api/config.yml', pull: {} }] }).items).toEqual([{ kind: 'file', path: 'api/config.yml' }])
    })

    it('rejects a pull that is not an object', () => {
      expect(() => readEnvironmentOptions({ files: [{ path: 'api/config.yml', pull: '0 * * * *' }] })).toThrow('invalid pull of api/config.yml in the environment: "0 * * * *"')
      expect(() => readEnvironmentOptions({ files: [{ path: 'api/config.yml', pull: true }] })).toThrow('invalid pull of api/config.yml in the environment: true')
      expect(() => readEnvironmentOptions({ files: [{ path: 'api/config.yml', pull: null }] })).toThrow('invalid pull of api/config.yml in the environment: null')
      expect(() => readEnvironmentOptions({ files: [{ path: 'api/config.yml', pull: [] }] })).toThrow('invalid pull of api/config.yml in the environment: []')
    })

    it('rejects a cron that is not a string', () => {
      expect(() => readEnvironmentOptions({ files: [{ path: 'api/config.yml', pull: { cron: 5 } }] })).toThrow('invalid pull of api/config.yml in the environment: {"cron":5}')
      expect(() => readEnvironmentOptions({ files: [{ path: 'api/config.yml', pull: { cron: null } }] })).toThrow('invalid pull of api/config.yml in the environment: {"cron":null}')
    })

    it('rejects a startup that is not a boolean', () => {
      expect(() => readEnvironmentOptions({ files: [{ path: 'api/config.yml', pull: { startup: 'yes' } }] })).toThrow('invalid pull of api/config.yml in the environment: {"startup":"yes"}')
    })

    it('reads the pull of databases, buckets and Redis databases', () => {
      const options = read({
        databases: [{ path: 'api/db.gz', engine: 'postgres', container: 'postgres', pull: { startup: true } }],
        buckets: [{ path: 'api/s3.gz', bucket: 'uploads-dev', pull: { cron: '0 3 * * *' } }],
        redis: [{ path: 'api/redis.gz', url: 'redis://localhost:6379/0', pull: { cron: '0 4 * * *', startup: true } }]
      })

      expect(options.autoPulls).toEqual([
        { path: 'api/db.gz', cron: null, startup: true },
        { path: 'api/s3.gz', cron: '0 3 * * *', startup: false },
        { path: 'api/redis.gz', cron: '0 4 * * *', startup: true }
      ])
    })

    it('rejects an invalid pull of a database, a bucket or a Redis database', () => {
      expect(() => readEnvironmentOptions({ databases: [{ path: 'api/db.gz', engine: 'postgres', container: 'postgres', pull: 'daily' }] })).toThrow('invalid pull of api/db.gz in the environment: "daily"')
      expect(() => readEnvironmentOptions({ buckets: [{ path: 'api/s3.gz', bucket: 'uploads-dev', pull: { startup: 1 } }] })).toThrow('invalid pull of api/s3.gz in the environment: {"startup":1}')
      expect(() => readEnvironmentOptions({ redis: [{ path: 'api/redis.gz', url: 'redis://localhost:6379/0', pull: { cron: false } }] })).toThrow('invalid pull of api/redis.gz in the environment: {"cron":false}')
    })

    it('keeps the auto pulls in the order of the items', () => {
      const options = read({
        files: [{ path: 'b/config.yml', pull: { startup: true } }, 'c/config.yml', { path: 'a/config.yml', pull: { startup: true } }]
      })

      expect(options.autoPulls.map(pull => pull.path)).toEqual(['b/config.yml', 'a/config.yml'])
    })
  })

  describe('databases', () => {
    it.each(['postgres', 'mariadb', 'mongodb'])('reads a %s database', engine => {
      expect(read({ databases: [{ path: 'api/db.gz', engine, container: 'db' }] }).items).toEqual([
        { kind: 'database', path: 'api/db.gz', engine, container: 'db' }
      ])
    })

    it('leaves databases out of the configuration files', () => {
      expect(read({ databases: [{ path: 'api/db.gz', engine: 'postgres', container: 'postgres' }] }).configFiles).toEqual([])
    })

    it('drops unknown keys of a database', () => {
      expect(read({ databases: [{ path: 'api/db.gz', engine: 'postgres', container: 'postgres', name: 'example' }] }).items).toEqual([
        { kind: 'database', path: 'api/db.gz', engine: 'postgres', container: 'postgres' }
      ])
    })

    it('rejects an unknown engine', () => {
      expect(() => readEnvironmentOptions({ databases: [{ path: 'api/db.gz', engine: 'sqlite', container: 'db' }] })).toThrow('invalid database in the environment: {"path":"api/db.gz","engine":"sqlite","container":"db"}')
      expect(() => readEnvironmentOptions({ databases: [{ path: 'api/db.gz', engine: 'toString', container: 'db' }] })).toThrow('invalid database in the environment')
      expect(() => readEnvironmentOptions({ databases: [{ path: 'api/db.gz', container: 'db' }] })).toThrow('invalid database in the environment: {"path":"api/db.gz","container":"db"}')
    })

    it('rejects a database without a string path or container', () => {
      expect(() => readEnvironmentOptions({ databases: [{ engine: 'postgres', container: 'db' }] })).toThrow('invalid database in the environment: {"engine":"postgres","container":"db"}')
      expect(() => readEnvironmentOptions({ databases: [{ path: 'api/db.gz', engine: 'postgres' }] })).toThrow('invalid database in the environment: {"path":"api/db.gz","engine":"postgres"}')
      expect(() => readEnvironmentOptions({ databases: [{ path: 'api/db.gz', engine: 'postgres', container: 1 }] })).toThrow('invalid database in the environment: {"path":"api/db.gz","engine":"postgres","container":1}')
    })

    it('rejects a database that is not an object', () => {
      expect(() => readEnvironmentOptions({ databases: ['api/db.gz'] })).toThrow('invalid database in the environment: {}')
    })

    it('ignores databases that are not a list', () => {
      expect(read({ databases: { path: 'api/db.gz', engine: 'postgres', container: 'postgres' } }).items).toEqual([])
    })
  })

  describe('buckets', () => {
    it('reads a bucket', () => {
      const options = read({ buckets: [{ path: 'api/s3.gz', bucket: 'uploads-dev' }] })

      expect(options.items).toEqual([{ kind: 'bucket', path: 'api/s3.gz', bucket: 'uploads-dev' }])
      expect(options.configFiles).toEqual([])
    })

    it('rejects a bucket without a string path or bucket name', () => {
      expect(() => readEnvironmentOptions({ buckets: [{ bucket: 'uploads-dev' }] })).toThrow('invalid bucket in the environment: {"bucket":"uploads-dev"}')
      expect(() => readEnvironmentOptions({ buckets: [{ path: 'api/s3.gz' }] })).toThrow('invalid bucket in the environment: {"path":"api/s3.gz"}')
      expect(() => readEnvironmentOptions({ buckets: [null] })).toThrow('invalid bucket in the environment: {}')
    })

    it('ignores buckets that are not a list', () => {
      expect(read({ buckets: 'api/s3.gz' }).items).toEqual([])
    })
  })

  describe('redis', () => {
    it('reads a Redis database', () => {
      const options = read({ redis: [{ path: 'api/redis.gz', url: 'redis://localhost:6379/0' }] })

      expect(options.items).toEqual([{ kind: 'redis', path: 'api/redis.gz', url: 'redis://localhost:6379/0' }])
      expect(options.configFiles).toEqual([])
    })

    it('rejects a Redis database without a string path or url, naming only its path', () => {
      expect(() => readEnvironmentOptions({ redis: [{ path: 'api/redis.gz' }] })).toThrow('invalid Redis database in the environment: {"path":"api/redis.gz"}')
      expect(() => readEnvironmentOptions({ redis: [{ url: 'redis://localhost:6379/0' }] })).toThrow('invalid Redis database in the environment: {}')
    })

    it('keeps the url out of the error message', () => {
      expect(() => readEnvironmentOptions({ redis: [{ path: 42, url: 'redis://user:secret@localhost:6379/0' }] })).toThrow(/^invalid Redis database in the environment: \{"path":42\}$/)
    })

    it('ignores Redis databases that are not a list', () => {
      expect(read({ redis: { path: 'api/redis.gz', url: 'redis://localhost:6379/0' } }).items).toEqual([])
    })
  })

  describe('s3', () => {
    it('reads the S3 server with its region', () => {
      expect(read({ s3: { endpoint: 'http://localhost:9000', accessKeyId: 'key', secretAccessKey: 'secret', region: 'eu-west-3' } }).s3).toEqual({
        endpoint: 'http://localhost:9000',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
        region: 'eu-west-3'
      })
    })

    it('defaults the region to us-east-1', () => {
      expect(read({ s3: { endpoint: 'http://localhost:9000', accessKeyId: 'key', secretAccessKey: 'secret' } }).s3?.region).toBe('us-east-1')
      expect(read({ s3: { endpoint: 'http://localhost:9000', accessKeyId: 'key', secretAccessKey: 'secret', region: 3 } }).s3?.region).toBe('us-east-1')
    })

    it('gives no S3 server when one of its settings is missing or not a string', () => {
      expect(read({ s3: { accessKeyId: 'key', secretAccessKey: 'secret' } }).s3).toBeNull()
      expect(read({ s3: { endpoint: 'http://localhost:9000', secretAccessKey: 'secret' } }).s3).toBeNull()
      expect(read({ s3: { endpoint: 'http://localhost:9000', accessKeyId: 'key' } }).s3).toBeNull()
      expect(read({ s3: { endpoint: 9000, accessKeyId: 'key', secretAccessKey: 'secret' } }).s3).toBeNull()
    })

    it('gives no S3 server when the setting is not an object', () => {
      expect(read({ s3: 'http://localhost:9000' }).s3).toBeNull()
      expect(read({ s3: null }).s3).toBeNull()
    })
  })
})

describe('parseTargets', () => {
  const options = environmentOf([fileItem, databaseItem, bucketItem, redisItem])

  it('selects every item, whole, when no target is given', () => {
    expect(parseTargets(options, [])).toEqual([
      { item: fileItem, tables: null },
      { item: databaseItem, tables: null },
      { item: bucketItem, tables: null },
      { item: redisItem, tables: null }
    ])
  })

  it('selects nothing in an empty environment without target', () => {
    expect(parseTargets(environmentOf([]), [])).toEqual([])
  })

  it('selects items by path, whole, in the order of the targets', () => {
    const selections = parseTargets(options, ['api/s3.gz', 'api/config.yml'])

    expect(selections).toEqual([{ item: bucketItem, tables: null }, { item: fileItem, tables: null }])
    expect(selections[0]?.item).toBe(bucketItem)
  })

  it('selects tables of a database', () => {
    expect(parseTargets(options, ['api/db.gz:public.user,public.session'])).toEqual([
      { item: databaseItem, tables: ['public.user', 'public.session'] }
    ])
  })

  it('selects key groups of a Redis database', () => {
    expect(parseTargets(options, ['api/redis.gz:session,cache'])).toEqual([
      { item: redisItem, tables: ['session', 'cache'] }
    ])
  })

  it('trims the tables and drops the empty ones', () => {
    expect(parseTargets(options, ['api/db.gz: public.user , ,public.session,'])).toEqual([
      { item: databaseItem, tables: ['public.user', 'public.session'] }
    ])
  })

  it('selects the whole database when the table list is empty', () => {
    expect(parseTargets(options, ['api/db.gz:'])).toEqual([{ item: databaseItem, tables: null }])
    expect(parseTargets(options, ['api/redis.gz: , '])).toEqual([{ item: redisItem, tables: null }])
  })

  it('splits the path at the first colon only', () => {
    expect(parseTargets(options, ['api/db.gz:schema:table'])).toEqual([{ item: databaseItem, tables: ['schema:table'] }])
  })

  it('mixes whole items and tables', () => {
    expect(parseTargets(options, ['api/config.yml', 'api/db.gz:public.user'])).toEqual([
      { item: fileItem, tables: null },
      { item: databaseItem, tables: ['public.user'] }
    ])
  })

  it('rejects a path that is not part of the environment, listing the known paths', () => {
    expect(() => parseTargets(options, ['api/missing.yml'])).toThrow('api/missing.yml is not part of the environment (api/config.yml, api/db.gz, api/s3.gz, api/redis.gz)')
    expect(() => parseTargets(options, ['api/missing.gz:public.user'])).toThrow('api/missing.gz is not part of the environment (api/config.yml, api/db.gz, api/s3.gz, api/redis.gz)')
  })

  it('rejects any path of an empty environment', () => {
    expect(() => parseTargets(environmentOf([]), ['api/config.yml'])).toThrow('api/config.yml is not part of the environment ()')
  })

  it('rejects tables of a file or a bucket', () => {
    expect(() => parseTargets(options, ['api/config.yml:public.user'])).toThrow('api/config.yml has no tables or key groups')
    expect(() => parseTargets(options, ['api/s3.gz:uploads'])).toThrow('api/s3.gz has no tables or key groups')
    expect(() => parseTargets(options, ['api/s3.gz:'])).toThrow('api/s3.gz has no tables or key groups')
  })
})

describe('overwritesLocalData', () => {
  it('is false for a configuration file', () => {
    expect(overwritesLocalData({ item: fileItem, tables: null })).toBe(false)
  })

  it.each([databaseItem, bucketItem, redisItem])('is true for a $kind', item => {
    expect(overwritesLocalData({ item, tables: null })).toBe(true)
    expect(overwritesLocalData({ item, tables: ['example'] })).toBe(true)
  })
})
