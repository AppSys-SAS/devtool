import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalBackendPath, type EnvironmentItem, type EnvironmentOptions, itemStoredAt, overwritesLocalData, parseTargets, readEnvironmentOptions, SHARED_CONFIG_PATH, transfersParts } from '../../src/environment.js'

const open = { groups: { pull: null, push: null } }
const fileItem: EnvironmentItem = { kind: 'file', path: 'api/config.yml', backend: null, encryption: null, ...open, ignore: null }
const databaseItem: EnvironmentItem = { kind: 'database', path: 'api/db.gz', backend: null, encryption: null, ...open, engine: 'postgres', container: 'postgres', database: null, format: 'devtool' }
const bucketItem: EnvironmentItem = { kind: 'bucket', path: 'api/s3.gz', backend: null, encryption: null, ...open, bucket: 'uploads-dev', format: 'devtool' }
const redisItem: EnvironmentItem = { kind: 'redis', path: 'api/redis.gz', backend: null, encryption: null, ...open, url: 'redis://localhost:6379/0' }

/**
 * Builds an environment made of the given items.
 *
 * @param items - The items of the environment.
 * @returns The environment, with no backend, configuration file, auto pull nor S3 server.
 */
function environmentOf (items: EnvironmentItem[]): EnvironmentOptions {
  return { folder: '/example/env', backends: [], defaultBackend: null, items, configFiles: [], autoPulls: [], s3: null }
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
        backends: [],
        defaultBackend: null,
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
        backends: [],
        defaultBackend: null,
        items: [
          { ...fileItem, path: 'devtool/config.yml' },
          fileItem,
          { ...fileItem, path: 'devtool/docker-compose.yml' },
          databaseItem,
          bucketItem
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

      expect(options.items).toEqual([fileItem])
      expect(options.configFiles).toEqual([{ path: 'api/config.yml', display: true, local: true }])
      expect(options.autoPulls).toEqual([])
    })

    it('defaults every flag of an object entry to true', () => {
      const options = read({ files: [{ path: 'api/config.yml' }] })

      expect(options.items).toEqual([fileItem])
      expect(options.configFiles).toEqual([{ path: 'api/config.yml', display: true, local: true }])
    })

    it('keeps flags explicitly set to true', () => {
      const options = read({ files: [{ path: 'api/config.yml', display: true, local: true, sync: true }] })

      expect(options.items).toEqual([fileItem])
      expect(options.configFiles).toEqual([{ path: 'api/config.yml', display: true, local: true }])
    })

    it('reads the keys a configuration file ignores', () => {
      const [item] = read({ files: [{ path: 'db/connections.json', ignore: ['connections.*.lastUsedAt'] }] }).items
      expect(item.kind === 'file' && item.ignore?.matches(['connections', '0', 'lastUsedAt'])).toBe(true)
      expect(read({ files: [{ path: 'db/connections.json', ignore: [] }] }).items[0]).toMatchObject({ ignore: null })
    })

    it('rejects ignored keys that are not key paths, or on a file without keys', () => {
      expect(() => read({ files: [{ path: 'a.json', ignore: 'connections' }] })).toThrow('invalid ignore of a.json in the environment: must be a list of key paths, such as connections.*.lastUsedAt')
      expect(() => read({ files: [{ path: 'a.txt', ignore: ['a'] }] })).toThrow('invalid ignore of a.txt in the environment: needs a YAML, JSON, TOML, XML or .env file')
    })

    it('hides a file from the configurations tab with display: false', () => {
      const options = read({ files: [{ path: 'api/config.yml', display: false }] })

      expect(options.configFiles).toEqual([{ path: 'api/config.yml', display: false, local: true }])
      expect(options.items).toEqual([fileItem])
    })

    it('leaves out the local override with local: false', () => {
      const options = read({ files: [{ path: 'api/config.yml', local: false }] })

      expect(options.configFiles).toEqual([{ path: 'api/config.yml', display: true, local: false }])
      expect(options.items).toEqual([fileItem])
    })

    it('keeps a file with sync: false out of the synchronized items', () => {
      const options = read({ files: [{ path: 'devtool/config.local.yml', sync: false }, 'api/config.yml'] })

      expect(options.configFiles).toEqual([
        { path: 'devtool/config.local.yml', display: true, local: true },
        { path: 'api/config.yml', display: true, local: true }
      ])
      expect(options.items).toEqual([fileItem])
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
      expect(read({ files: [{ path: 'api/config.yml', pull: {} }] }).items).toEqual([fileItem])
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
        { ...databaseItem, engine, container: 'db' }
      ])
    })

    it('reads the database of the container and the archive format', () => {
      expect(read({ databases: [{ path: 'api/db.gz', engine: 'mongodb', container: 'mongo', database: 'catalog', format: 'native' }] }).items).toEqual([
        { ...databaseItem, engine: 'mongodb', container: 'mongo', database: 'catalog', format: 'native' }
      ])
    })

    it('lets several items name databases of one container', () => {
      const options = read({
        databases: [
          { path: 'api/catalog.gz', engine: 'mongodb', container: 'mongo', database: 'catalog' },
          { path: 'api/orders.gz', engine: 'mongodb', container: 'mongo', database: 'orders' }
        ]
      })
      expect(options.items.map(item => item.kind === 'database' && [item.container, item.database])).toEqual([['mongo', 'catalog'], ['mongo', 'orders']])
    })

    it('rejects a blank or non-string database, and an unknown format', () => {
      expect(() => readEnvironmentOptions({ databases: [{ path: 'api/db.gz', engine: 'postgres', container: 'db', database: ' ' }] })).toThrow('invalid database in the environment')
      expect(() => readEnvironmentOptions({ databases: [{ path: 'api/db.gz', engine: 'postgres', container: 'db', database: 3 }] })).toThrow('invalid database in the environment')
      expect(() => readEnvironmentOptions({ databases: [{ path: 'api/db.gz', engine: 'postgres', container: 'db', format: 'sql' }] })).toThrow('invalid format of api/db.gz in the environment: must be devtool or native')
    })

    it('leaves databases out of the configuration files', () => {
      expect(read({ databases: [{ path: 'api/db.gz', engine: 'postgres', container: 'postgres' }] }).configFiles).toEqual([])
    })

    it('drops unknown keys of a database', () => {
      expect(read({ databases: [{ path: 'api/db.gz', engine: 'postgres', container: 'postgres', name: 'example' }] }).items).toEqual([databaseItem])
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

      expect(options.items).toEqual([bucketItem])
      expect(options.configFiles).toEqual([])
    })

    it('reads the archive format of a bucket', () => {
      expect(read({ buckets: [{ path: 'api/s3.tar.gz', bucket: 'uploads-dev', format: 'native' }] }).items).toEqual([{ ...bucketItem, path: 'api/s3.tar.gz', format: 'native' }])
      expect(() => readEnvironmentOptions({ buckets: [{ path: 'api/s3.gz', bucket: 'uploads-dev', format: 'zip' }] })).toThrow('invalid format of api/s3.gz')
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

      expect(options.items).toEqual([redisItem])
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

  describe('backends', () => {
    const backends = {
      team: { type: 'cdn', url: 'https://files.example.dev/' },
      nas: { type: 'sftp', host: 'nas.example.dev', username: 'dev', default: true },
      archive: { type: 's3', bucket: 'acme-dev', prefix: 'env' }
    }

    it('reads the backends, the default one being the one marked default', () => {
      const options = read({ backends })
      expect(options.backends.map(backend => [backend.slug, backend.type])).toEqual([['team', 'cdn'], ['nas', 'sftp'], ['archive', 's3']])
      expect(options.defaultBackend).toBe('nas')
      expect(options.backends[0]).toMatchObject({ url: 'https://files.example.dev', default: false, encryption: null })
      expect(options.backends[2]).toMatchObject({ prefix: 'env/', region: 'us-east-1', pathStyle: false })
    })

    it('takes the first backend as default when none is marked, and the first marked one when several are', () => {
      expect(read({ backends: { team: backends.team, archive: backends.archive } }).defaultBackend).toBe('team')
      expect(read({ backends: { a: { ...backends.team, default: true }, b: { ...backends.team, default: true } } }).defaultBackend).toBe('a')
    })

    it('gives each item its backend, the default one when it names none', () => {
      const options = read({ backends, files: ['devtool/config.yml', { path: 'api/config.yml', backend: 'team' }], databases: [{ path: 'api/db.gz', engine: 'postgres', container: 'postgres', backend: 'archive' }] })
      expect(options.items.map(item => [item.path, item.backend])).toEqual([['devtool/config.yml', 'nas'], ['api/config.yml', 'team'], ['api/db.gz', 'archive']])
    })

    it('rejects an item naming an unknown backend, and invalid backends', () => {
      expect(() => readEnvironmentOptions({ backends, files: [{ path: 'api/config.yml', backend: 'cloud' }] })).toThrow('api/config.yml: backend "cloud" is not declared in environment.backends')
      expect(() => readEnvironmentOptions({ backends: { team: { type: 'ftp' } } })).toThrow('environment.backends.team.type must be one of cdn, s3, sftp, git, scripts')
      expect(() => readEnvironmentOptions({ backends: { team: { type: 'cdn' } } })).toThrow('environment.backends.team.url must be the http or https address of the CDN')
      expect(() => readEnvironmentOptions({ backends: { team: { ...backends.team, encryption: { key: 'a', password: 'b' } } } })).toThrow('environment.backends.team.encryption must be')
    })

    it('reads the encryption of a backend', () => {
      expect(read({ backends: { team: { ...backends.team, encryption: { prompt: true } } } }).backends[0].encryption).toEqual({ prompt: true })
    })
  })

  describe('paths', () => {
    it('refuses an item path that is not in its canonical form, so its groups cannot be bypassed through an alias', () => {
      expect(() => readEnvironmentOptions({ files: [{ path: 'api/./config.yml', groups: { pull: ['admins'] } }] })).toThrow('invalid path of api/./config.yml in the environment: write it api/config.yml')
      expect(() => readEnvironmentOptions({ databases: [{ path: '/api/db.gz', engine: 'postgres', container: 'db' }] })).toThrow('write it api/db.gz')
      expect(() => readEnvironmentOptions({ files: ['../secrets.yml'] })).toThrow('is not a path inside the backend')
      for (const outside of ['x\\..', '..\\x', '‥/x']) {
        expect(() => readEnvironmentOptions({ files: [outside] }), outside).toThrow(`${outside} is not a path inside the backend`)
      }
    })

    it('refuses an item path inside the folder holding the locks of the transfers, whatever its spelling', () => {
      for (const reserved of ['.devtool-locks', '.DEVTOOL-LOCKS', '.devtool-locks/x.lock', '.DEVTOOL-LOCKS/x.lock', '.devtool-locks\\x.lock']) {
        expect(() => readEnvironmentOptions({ files: [reserved] }), reserved).toThrow(`invalid path of ${reserved} in the environment: .devtool-locks holds the locks of the transfers`)
      }
    })

    it('refuses an item path declared twice', () => {
      expect(() => readEnvironmentOptions({ files: ['api/config.yml'], buckets: [{ path: 'api/config.yml', bucket: 'b' }] })).toThrow('api/config.yml is declared twice in the environment')
    })

    it('refuses item paths differing only by letter case, Unicode form or path spelling, which one store may hold as one file', () => {
      expect(() => readEnvironmentOptions({ files: ['api/config.yml', 'API/config.yml'] })).toThrow(
        'API/config.yml and api/config.yml differ only by letter case, Unicode form or path spelling, which a backend or a disk may store as one file: declare one of them'
      )
      expect(() => readEnvironmentOptions({ files: ['api/café.yml'.normalize('NFC'), 'api/café.yml'.normalize('NFD')] })).toThrow('differ only by letter case, Unicode form or path spelling')
      for (const alias of ['api\\config.yml', 'api\\.\\config.yml', 'api\\other\\..\\config.yml']) {
        expect(() => readEnvironmentOptions({ files: ['api/config.yml', alias] }), alias).toThrow('differ only by letter case, Unicode form or path spelling')
      }
    })
  })

  describe('groups', () => {
    const backends = {
      team: { type: 'cdn', url: 'https://files.example.dev/', groups: { pull: ['developers'], push: false } },
      nas: { type: 'sftp', host: 'nas.example.dev', username: 'dev' }
    }

    it('reads the groups of a backend, everyone being let in a direction it leaves out', () => {
      const options = read({ backends })
      expect(options.backends.map(backend => backend.groups)).toEqual([{ pull: ['developers'], push: false }, { pull: null, push: null }])
    })

    it('gives each item the groups of its backend, its own groups replacing them except where the backend refuses everyone', () => {
      const options = read({
        backends,
        files: ['api/config.yml', { path: 'api/keys.yml', groups: { pull: ['admins'], push: ['admins'] } }],
        databases: [{ path: 'api/db.gz', engine: 'postgres', container: 'postgres', backend: 'nas', groups: { pull: false } }]
      })
      expect(options.items.map(item => [item.path, item.groups])).toEqual([
        ['api/config.yml', { pull: ['developers'], push: false }],
        ['api/keys.yml', { pull: ['admins'], push: false }],
        ['api/db.gz', { pull: false, push: null }]
      ])
    })

    it('rejects groups that are not a non-empty list or false', () => {
      expect(() => readEnvironmentOptions({ backends: { team: { ...backends.team, groups: { push: [] } } } })).toThrow('environment.backends.team.groups push must be a non-empty list of groups, or false')
      expect(() => readEnvironmentOptions({ backends: { team: { ...backends.team, groups: { write: false } } } })).toThrow('write is unknown: only pull and push')
      expect(() => readEnvironmentOptions({ files: [{ path: 'api/config.yml', groups: ['admins'] }] })).toThrow('invalid groups of api/config.yml in the environment: must be a map of pull and push groups')
      expect(() => readEnvironmentOptions({ files: [{ path: 'api/config.yml', groups: { pull: true } }] })).toThrow('invalid groups of api/config.yml in the environment: pull must be')
    })
  })

  describe('encryption', () => {
    const rules = [{ paths: ['secrets/**', '**/*.env'], password: '{{ op://dev/env/password }}' }, { paths: ['api/*'], prompt: true }]

    it('encrypts the items matching a rule, the first matching rule winning, an item setting overriding them', () => {
      const options = read({
        encryption: rules,
        files: ['secrets/api/token.yml', 'api/prod.env', 'api/config.yml', { path: 'api/keys.yml', encryption: { key: 'S2V5' } }, 'web/config.yml']
      })
      expect(options.items.map(item => [item.path, item.encryption])).toEqual([
        ['secrets/api/token.yml', { password: '{{ op://dev/env/password }}' }],
        ['api/prod.env', { password: '{{ op://dev/env/password }}' }],
        ['api/config.yml', { prompt: true }],
        ['api/keys.yml', { key: 'S2V5' }],
        ['web/config.yml', null]
      ])
    })

    it('rejects a rule without paths or secret, and an invalid item setting', () => {
      expect(() => readEnvironmentOptions({ encryption: [{ password: 'x' }] })).toThrow('environment.encryption[0] needs paths')
      expect(() => readEnvironmentOptions({ encryption: [{ paths: ['*'] }] })).toThrow('environment.encryption[0] needs paths and must be')
      expect(() => readEnvironmentOptions({ files: [{ path: 'api/config.yml', encryption: { prompt: 'yes' } }] })).toThrow('invalid encryption of api/config.yml')
    })
  })
})

describe('canonicalBackendPath', () => {
  it('gives every spelling of a path the form items are declared with', () => {
    for (const spelling of ['shop/orders.gz', './shop/orders.gz', '/shop/orders.gz', 'shop//orders.gz', 'shop/./orders.gz', 'tmp/../shop/orders.gz']) {
      expect(canonicalBackendPath(spelling)).toBe('shop/orders.gz')
    }
  })

  it('refuses a path outside the backend or naming its root', () => {
    for (const spelling of ['', '.', './', '..', '../shop/orders.gz', 'shop/../../orders.gz']) {
      expect(() => canonicalBackendPath(spelling)).toThrow('is not a path inside the backend')
    }
  })
})

describe('itemStoredAt', () => {
  const items = [{ ...databaseItem, backend: 'team' }, { ...fileItem, backend: 'archive' }]

  it('finds the item a backend stores at a path, and none at another path or on another backend', () => {
    expect(itemStoredAt(items, 'team', 'api/db.gz')).toBe(items[0])
    expect(itemStoredAt(items, 'team', 'api/other.gz')).toBeNull()
    expect(itemStoredAt(items, 'team', 'api/config.yml')).toBeNull()
  })

  it('refuses a path naming an item in another letter case, Unicode form or path spelling, which a backend may store as the same file', () => {
    expect(() => itemStoredAt(items, 'team', 'API/db.gz')).toThrow('API/db.gz names the item api/db.gz in another letter case, Unicode form or path spelling: write its path exactly')
    const aliases: [string, string][] = [
      ['api/café.gz'.normalize('NFC'), 'api/café.gz'.normalize('NFD')],
      ['api/config.yml', 'api\\config.yml'],
      ['api/config.yml', 'api\\.\\config.yml'],
      ['api/config.yml', 'api\\\\config.yml'],
      ['api/config.yml', 'api\\other\\..\\config.yml'],
      ['api/config.yml', '.\\API\\config.yml'],
      ['api/nested/config.yml', 'api\\nested/config.yml'],
      ['api/straße.gz', 'api/strasse.gz'],
      ['api/ſecret.gz', 'api/secret.gz'],
      ['api/οδος.gz', 'api/οδοσ.gz'],
      ['api/ﬁle.gz', 'api/file.gz']
    ]
    for (const [declared, written] of aliases) {
      expect(() => itemStoredAt([{ ...databaseItem, backend: 'team', path: declared }], 'team', written), written).toThrow('write its path exactly')
    }
    expect(itemStoredAt([...items, { ...databaseItem, backend: 'team', path: 'API/db.gz' }], 'team', 'API/db.gz')?.path).toBe('API/db.gz')
  })
})

describe('transfersParts', () => {
  it('lets some tables or key groups be chosen except in a native archive pushed or a native mariadb archive', () => {
    const native = { ...databaseItem, format: 'native' as const }
    expect([transfersParts(databaseItem, 'pull'), transfersParts(databaseItem, 'push')]).toEqual([true, true])
    expect([transfersParts(native, 'pull'), transfersParts(native, 'push')]).toEqual([true, false])
    expect([transfersParts({ ...native, engine: 'mariadb' }, 'pull'), transfersParts({ ...native, engine: 'mariadb' }, 'push')]).toEqual([false, false])
    expect([transfersParts(redisItem, 'pull'), transfersParts(fileItem, 'pull'), transfersParts(bucketItem, 'pull')]).toEqual([true, false, false])
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
