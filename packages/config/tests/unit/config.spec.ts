import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONFIG_FOLDER_VARIABLE,
  configSourceKey,
  loadConfigFile,
  loadMergedConfig,
  mergeConfig,
  resolveAppIdentity,
  resolveCacheFolder,
  resolveConfigFolder,
  resolveDefaultConfigPaths
} from '../../src/index.js'
import type { ConfigSources, RawConfig } from '../../src/index.js'

const temporaryFolders: string[] = []

/**
 * Creates an empty temporary folder, removed after the test.
 * @returns The real absolute path of the folder.
 */
async function makeTemporaryFolder (): Promise<string> {
  const folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devtool-config-')))
  temporaryFolders.push(folder)
  return folder
}

/**
 * Writes a file, creating its parent folders.
 * @param folder - The folder the file path is relative to.
 * @param relativePath - The path of the file inside the folder.
 * @param content - The content of the file.
 * @returns The absolute path of the file.
 */
async function writeFile (folder: string, relativePath: string, content: string): Promise<string> {
  const filePath = path.join(folder, relativePath)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content)
  return filePath
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(temporaryFolders.splice(0).map(folder => fs.rm(folder, { recursive: true, force: true })))
})

describe('mergeConfig', () => {
  it('joins include lists instead of replacing them', () => {
    expect(mergeConfig({ include: ['a.yml'] }, { include: ['b.yml'] })).toEqual({ include: ['a.yml', 'b.yml'] })
  })

  it('joins include lists at any depth', () => {
    expect(mergeConfig({ nested: { include: ['a.yml'] } }, { nested: { include: ['b.yml'] } }))
      .toEqual({ nested: { include: ['a.yml', 'b.yml'] } })
  })

  it('merges other lists item by item', () => {
    expect(mergeConfig({ list: ['a', 'b'] }, { list: ['c'] })).toEqual({ list: ['c', 'b'] })
  })

  it('merges objects deeply, the second overriding the first', () => {
    const merged = mergeConfig(
      { adt: { name: 'first', displayName: 'First' }, workspace: '/first' },
      { adt: { name: 'second' }, cdn: { url: 'https://example.dev' } }
    )

    expect(merged).toEqual({
      adt: { name: 'second', displayName: 'First' },
      workspace: '/first',
      cdn: { url: 'https://example.dev' }
    })
  })

  it('merges an object item over a text item as its path', () => {
    expect(mergeConfig({ list: ['api'] }, { list: [{ name: 'Api' }] })).toEqual({ list: [{ path: 'api', name: 'Api' }] })
  })

  it('lets an object item override the path of a text item', () => {
    expect(mergeConfig({ list: ['api'] }, { list: [{ path: 'web', name: 'Web' }] })).toEqual({ list: [{ path: 'web', name: 'Web' }] })
  })

  it('keeps a text value merged over an object outside lists', () => {
    expect(mergeConfig({ setting: 'api' }, { setting: { name: 'Api' } })).toEqual({ setting: { name: 'Api' } })
  })

  it('replaces an item by a text item', () => {
    expect(mergeConfig({ list: [{ path: 'api' }] }, { list: ['web'] })).toEqual({ list: ['web'] })
  })

  it('changes and returns the first configuration', () => {
    const target: RawConfig = { a: 1 }

    const merged = mergeConfig(target, { b: 2 })

    expect(merged).toBe(target)
    expect(target).toEqual({ a: 1, b: 2 })
  })

  it('copies the second configuration instead of sharing its values', () => {
    const source = { adt: { name: 'second' }, include: ['b.yml'] }

    const merged = mergeConfig<RawConfig>({}, source)
    ;(merged.adt as Record<string, unknown>).name = 'changed'
    ;(merged.include as string[]).push('c.yml')

    expect(source).toEqual({ adt: { name: 'second' }, include: ['b.yml'] })
  })
})

describe('configSourceKey', () => {
  it('names a setting by its keys, indexes as text', () => {
    expect(configSourceKey(['projects', 'api', 0])).toBe('["projects","api","0"]')
  })

  it('names an empty path', () => {
    expect(configSourceKey([])).toBe('[]')
  })

  it('keeps keys holding dots or quotes apart', () => {
    expect(configSourceKey(['a.b'])).not.toBe(configSourceKey(['a', 'b']))
    expect(configSourceKey(['say "hi"'])).toBe('["say \\"hi\\""]')
  })
})

describe('loadConfigFile', () => {
  let folder: string

  beforeEach(async () => {
    folder = await makeTemporaryFolder()
  })

  it('loads a YAML file', async () => {
    const file = await writeFile(folder, 'config.yml', 'adt:\n  name: example\ncount: 3\nenabled: true\n')

    expect(await loadConfigFile(file)).toEqual({ adt: { name: 'example' }, count: 3, enabled: true })
  })

  it.each([
    ['an empty file', ''],
    ['a file holding blank lines only', '\n\n'],
    ['a file holding comments only', '# personal overrides\n# none yet\n'],
    ['a null document', '---\n']
  ])('gives an empty configuration and no source for %s', async (_, content) => {
    const file = await writeFile(folder, 'config.yml', content)
    const sources: ConfigSources = {}

    expect(await loadConfigFile(file, undefined, sources)).toEqual({})
    expect(sources).toEqual({})
  })

  it('rejects a file holding several documents', async () => {
    const file = await writeFile(folder, 'config.yml', 'a: 1\n---\nb: 2\n')

    await expect(loadConfigFile(file)).rejects.toThrow(file)
  })

  it('gives an empty configuration for a file holding a single value', async () => {
    const file = await writeFile(folder, 'config.yml', 'just a text\n')

    expect(await loadConfigFile(file)).toEqual({})
  })

  it('rejects a missing file', async () => {
    await expect(loadConfigFile(path.join(folder, 'missing.yml'))).rejects.toThrow()
  })

  it('rejects an invalid YAML file, naming it', async () => {
    const file = await writeFile(folder, 'config.yml', 'adt: [unclosed\n')

    await expect(loadConfigFile(file)).rejects.toThrow(file)
  })

  it('rejects an invalid YAML file holding comments', async () => {
    const file = await writeFile(folder, 'config.yml', '# settings\nadt: {unclosed\n')

    await expect(loadConfigFile(file)).rejects.toThrow()
  })

  it('expands $VAR and ${VAR} in values at any depth', async () => {
    vi.stubEnv('ADT_TEST_HOST', 'example.dev')
    vi.stubEnv('ADT_TEST_PORT', '8080')
    const file = await writeFile(folder, 'config.yml', [
      'url: https://$ADT_TEST_HOST:${ADT_TEST_PORT}/api',
      'nested:',
      '  list:',
      '    - ${ADT_TEST_HOST}',
      '    - item: $ADT_TEST_PORT',
      ''
    ].join('\n'))

    expect(await loadConfigFile(file)).toEqual({
      url: 'https://example.dev:8080/api',
      nested: { list: ['example.dev', { item: '8080' }] }
    })
  })

  it('leaves unknown variables and other dollar signs as written', async () => {
    vi.stubEnv('ADT_TEST_UNSET', undefined)
    const file = await writeFile(folder, 'config.yml', [
      'plain: $ADT_TEST_UNSET/a',
      'braced: ${ADT_TEST_UNSET}/b',
      'price: costs $5',
      'alone: a $ sign',
      ''
    ].join('\n'))

    expect(await loadConfigFile(file)).toEqual({
      plain: '$ADT_TEST_UNSET/a',
      braced: '${ADT_TEST_UNSET}/b',
      price: 'costs $5',
      alone: 'a $ sign'
    })
  })

  it('expands a variable set to an empty text', async () => {
    vi.stubEnv('ADT_TEST_EMPTY', '')
    const file = await writeFile(folder, 'config.yml', 'value: a${ADT_TEST_EMPTY}b\n')

    expect(await loadConfigFile(file)).toEqual({ value: 'ab' })
  })

  it('does not expand variables in keys nor touch values other than texts', async () => {
    vi.stubEnv('ADT_TEST_KEY', 'expanded')
    const file = await writeFile(folder, 'config.yml', '$ADT_TEST_KEY: 1\nflag: false\nempty: null\n')

    expect(await loadConfigFile(file)).toEqual({ $ADT_TEST_KEY: 1, flag: false, empty: null })
  })

  it('expands ~/ at the start of a value to the home folder only', async () => {
    const home = await makeTemporaryFolder()
    vi.stubEnv('HOME', home)
    const file = await writeFile(folder, 'config.yml', [
      'start: ~/Workspace',
      'middle: a/~/b',
      'tilde: "~"',
      'user: ~user/b',
      ''
    ].join('\n'))

    expect(await loadConfigFile(file)).toEqual({
      start: path.join(home, 'Workspace'),
      middle: 'a/~/b',
      tilde: '~',
      user: '~user/b'
    })
  })

  it('merges included files matching a glob relative to the file, in name order', async () => {
    await writeFile(folder, 'parts/b.yml', 'order: b\nb: true\n')
    await writeFile(folder, 'parts/a.yml', 'order: a\na: true\n')
    await writeFile(folder, 'parts/ignored.txt', 'ignored: true\n')
    const file = await writeFile(folder, 'config.yml', 'include:\n  - parts/*.yml\nroot: true\n')

    expect(await loadConfigFile(file)).toEqual({ root: true, a: true, b: true, order: 'b' })
  })

  it('merges included files over the file including them', async () => {
    await writeFile(folder, 'part.yml', 'adt:\n  name: included\n')
    const file = await writeFile(folder, 'config.yml', 'include: [part.yml]\nadt:\n  name: root\n  displayName: Root\n')

    expect(await loadConfigFile(file)).toEqual({ adt: { name: 'included', displayName: 'Root' } })
  })

  it('merges includes in the order they are listed', async () => {
    await writeFile(folder, 'first.yml', 'value: first\n')
    await writeFile(folder, 'second.yml', 'value: second\n')
    const file = await writeFile(folder, 'config.yml', 'include: [second.yml, first.yml]\n')

    expect(await loadConfigFile(file)).toEqual({ value: 'first' })
  })

  it('resolves nested includes from the folder of the file including them', async () => {
    await writeFile(folder, 'sub/deep/leaf.yml', 'leaf: true\n')
    await writeFile(folder, 'sub/middle.yml', 'include: [deep/leaf.yml]\nmiddle: true\n')
    const file = await writeFile(folder, 'config.yml', 'include: [sub/middle.yml]\n')

    expect(await loadConfigFile(file)).toEqual({ middle: true, leaf: true })
  })

  it('accepts absolute, home and variable includes', async () => {
    const home = await makeTemporaryFolder()
    vi.stubEnv('HOME', home)
    vi.stubEnv('ADT_TEST_PARTS', path.join(folder, 'variable'))
    await writeFile(folder, 'absolute/part.yml', 'absolute: true\n')
    await writeFile(home, 'part.yml', 'home: true\n')
    await writeFile(folder, 'variable/part.yml', 'variable: true\n')
    const file = await writeFile(folder, 'config.yml', [
      'include:',
      `  - ${path.join(folder, 'absolute/*.yml')}`,
      '  - ~/part.yml',
      '  - ${ADT_TEST_PARTS}/*.yml',
      ''
    ].join('\n'))

    expect(await loadConfigFile(file)).toEqual({ absolute: true, home: true, variable: true })
  })

  it('ignores includes matching no file and include items that are not texts', async () => {
    const file = await writeFile(folder, 'config.yml', 'include:\n  - missing/*.yml\n  - path: other.yml\n  - 3\nroot: true\n')

    expect(await loadConfigFile(file)).toEqual({ root: true })
  })

  it('ignores an include setting that is not a list', async () => {
    await writeFile(folder, 'part.yml', 'part: true\n')
    const file = await writeFile(folder, 'config.yml', 'include: part.yml\nroot: true\n')

    expect(await loadConfigFile(file)).toEqual({ root: true })
  })

  it('removes the include setting from the configuration', async () => {
    await writeFile(folder, 'part.yml', 'include: []\npart: true\n')
    const file = await writeFile(folder, 'config.yml', 'include: [part.yml]\n')

    expect(await loadConfigFile(file)).not.toHaveProperty('include')
  })

  it('loads a file including itself once', async () => {
    const file = await writeFile(folder, 'config.yml', 'include: [config.yml]\nroot: true\n')

    expect(await loadConfigFile(file)).toEqual({ root: true })
  })

  it('stops include cycles', async () => {
    await writeFile(folder, 'b.yml', 'include: [config.yml]\nb: true\nvalue: b\n')
    const file = await writeFile(folder, 'config.yml', 'include: [b.yml]\na: true\nvalue: a\n')

    expect(await loadConfigFile(file)).toEqual({ a: true, b: true, value: 'b' })
  })

  it('loads a file included twice once', async () => {
    await writeFile(folder, 'shared.yml', 'shared: true\n')
    await writeFile(folder, 'left.yml', 'include: [shared.yml]\nleft: true\n')
    await writeFile(folder, 'right.yml', 'include: [shared.yml]\nright: true\nshared: false\n')
    const file = await writeFile(folder, 'config.yml', 'include: [left.yml, right.yml]\n')

    expect(await loadConfigFile(file)).toEqual({ left: true, right: true, shared: false })
  })

  it('resolves relative folder paths from the folder of the file', async () => {
    const file = await writeFile(folder, 'config.yml', [
      'workspace: workspace',
      'adt:',
      '  cacheDir: cache',
      '  icon: assets/icon.svg',
      '  name: not-a-path',
      'environment:',
      '  folder: ..',
      'loadBalancers:',
      '  main:',
      '    crt: certs/main.crt',
      '    key: certs/main.key',
      '    port: 443',
      'other: relative/path',
      ''
    ].join('\n'))

    expect(await loadConfigFile(file)).toEqual({
      workspace: path.join(folder, 'workspace'),
      adt: { cacheDir: path.join(folder, 'cache'), icon: path.join(folder, 'assets/icon.svg'), name: 'not-a-path' },
      environment: { folder: path.dirname(folder) },
      loadBalancers: { main: { crt: path.join(folder, 'certs/main.crt'), key: path.join(folder, 'certs/main.key'), port: 443 } },
      other: 'relative/path'
    })
  })

  it('resolves relative folder paths from a given base folder', async () => {
    const base = await makeTemporaryFolder()
    const file = await writeFile(folder, 'config.yml', 'workspace: workspace\nadt:\n  cacheDir: cache\n')

    expect(await loadConfigFile(file, base)).toEqual({
      workspace: path.join(base, 'workspace'),
      adt: { cacheDir: path.join(base, 'cache') }
    })
  })

  it('resolves the folder paths of included files from the base folder, not their own folder', async () => {
    await writeFile(folder, 'sub/part.yml', 'workspace: workspace\nenvironment:\n  folder: mirror\n')
    const file = await writeFile(folder, 'config.yml', 'include: [sub/part.yml]\n')

    expect(await loadConfigFile(file)).toEqual({
      workspace: path.join(folder, 'workspace'),
      environment: { folder: path.join(folder, 'mirror') }
    })
  })

  it('leaves absolute paths, PEM values and values other than texts untouched', async () => {
    const file = await writeFile(folder, 'config.yml', [
      'workspace: /absolute/workspace',
      'adt:',
      '  cacheDir: 42',
      'environment: mirror',
      'loadBalancers:',
      '  inline:',
      '    crt: "  -----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----"',
      '    key: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----"',
      '  disabled: null',
      '  flag: true',
      ''
    ].join('\n'))

    expect(await loadConfigFile(file)).toEqual({
      workspace: '/absolute/workspace',
      adt: { cacheDir: 42 },
      environment: 'mirror',
      loadBalancers: {
        inline: {
          crt: '  -----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
          key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
        },
        disabled: null,
        flag: true
      }
    })
  })

  it('leaves section paths unresolved', async () => {
    const file = await writeFile(folder, 'config.yml', 'sections:\n  api:\n    path: api\n  web: {}\n')

    expect(await loadConfigFile(file)).toEqual({ sections: { api: { path: 'api' }, web: {} } })
  })

  it('records the file declaring each setting, list indexes included', async () => {
    const file = await writeFile(folder, 'config.yml', 'adt:\n  name: example\nprojects:\n  api:\n    commands: [test, lint]\n')
    const sources: ConfigSources = {}

    await loadConfigFile(file, undefined, sources)

    expect(sources).toEqual({
      [configSourceKey(['adt'])]: [file],
      [configSourceKey(['adt', 'name'])]: [file],
      [configSourceKey(['projects'])]: [file],
      [configSourceKey(['projects', 'api'])]: [file],
      [configSourceKey(['projects', 'api', 'commands'])]: [file],
      [configSourceKey(['projects', 'api', 'commands', 0])]: [file],
      [configSourceKey(['projects', 'api', 'commands', 1])]: [file]
    })
  })

  it('records a file before the files it includes', async () => {
    const part = await writeFile(folder, 'parts/part.yml', 'adt:\n  name: included\npart: true\n')
    const file = await writeFile(folder, 'config.yml', 'include: [parts/part.yml]\nadt:\n  name: root\n')
    const sources: ConfigSources = {}

    await loadConfigFile(file, undefined, sources)

    expect(sources).toEqual({
      [configSourceKey(['adt'])]: [file, part],
      [configSourceKey(['adt', 'name'])]: [file, part],
      [configSourceKey(['part'])]: [part]
    })
  })

  it('records no file as declaring the include setting', async () => {
    const part = await writeFile(folder, 'part.yml', 'include: [missing.yml]\npart: true\n')
    const file = await writeFile(folder, 'config.yml', 'include: [part.yml]\n')
    const sources: ConfigSources = {}

    await loadConfigFile(file, undefined, sources)

    expect(sources).toEqual({ [configSourceKey(['part'])]: [part] })
  })

  it('records a file including an empty file', async () => {
    await writeFile(folder, 'empty.yml', '')
    const file = await writeFile(folder, 'config.yml', 'include: [empty.yml]\nroot: true\n')
    const sources: ConfigSources = {}

    expect(await loadConfigFile(file, undefined, sources)).toEqual({ root: true })
    expect(sources).toEqual({ [configSourceKey(['root'])]: [file] })
  })

  it('adds to the sources it is given', async () => {
    const file = await writeFile(folder, 'config.yml', 'adt:\n  name: example\n')
    const sources: ConfigSources = { [configSourceKey(['adt'])]: ['/earlier.yml'] }

    await loadConfigFile(file, undefined, sources)

    expect(sources[configSourceKey(['adt'])]).toEqual(['/earlier.yml', file])
  })
})

describe('resolveConfigFolder', () => {
  it('exposes the name of its environment variable', () => {
    expect(CONFIG_FOLDER_VARIABLE).toBe('ADT_CONFIG_FOLDER')
  })

  it('gives the folder named by the environment variable', () => {
    vi.stubEnv(CONFIG_FOLDER_VARIABLE, '/example/config')

    expect(resolveConfigFolder()).toBe('/example/config')
  })

  it('trims the environment variable and expands ~/', async () => {
    const home = await makeTemporaryFolder()
    vi.stubEnv('HOME', home)
    vi.stubEnv(CONFIG_FOLDER_VARIABLE, '  ~/settings  ')

    expect(resolveConfigFolder()).toBe(path.join(home, 'settings'))
  })

  it('resolves a relative folder from the working directory', () => {
    vi.stubEnv(CONFIG_FOLDER_VARIABLE, 'relative/config')

    expect(resolveConfigFolder()).toBe(path.resolve(process.cwd(), 'relative/config'))
  })

  it('gives ~/.config/appsys/devtool without the environment variable', async () => {
    const home = await makeTemporaryFolder()
    vi.stubEnv('HOME', home)
    vi.stubEnv(CONFIG_FOLDER_VARIABLE, undefined)

    expect(resolveConfigFolder()).toBe(path.join(home, '.config/appsys/devtool'))
  })

  it('gives the default folder when the environment variable is blank', async () => {
    const home = await makeTemporaryFolder()
    vi.stubEnv('HOME', home)
    vi.stubEnv(CONFIG_FOLDER_VARIABLE, '   ')

    expect(resolveConfigFolder()).toBe(path.join(home, '.config/appsys/devtool'))
  })
})

describe('resolveCacheFolder', () => {
  it('gives adt.cacheDir as it is', () => {
    expect(resolveCacheFolder({ adt: { cacheDir: '/example/cache' } })).toBe('/example/cache')
  })

  it.each([
    ['no adt settings', {}],
    ['adt settings that are not an object', { adt: 'example' }],
    ['null adt settings', { adt: null }],
    ['no adt.cacheDir', { adt: {} }],
    ['a blank adt.cacheDir', { adt: { cacheDir: '   ' } }],
    ['an adt.cacheDir that is not a text', { adt: { cacheDir: 42 } }]
  ])('gives ~/.cache/appsys/devtool with %s', async (_, config) => {
    const home = await makeTemporaryFolder()
    vi.stubEnv('HOME', home)

    expect(resolveCacheFolder(config)).toBe(path.join(home, '.cache/appsys/devtool'))
  })
})

describe('resolveAppIdentity', () => {
  it('gives the default identity without adt settings', () => {
    expect(resolveAppIdentity({})).toEqual({
      identity: { name: 'appsys-devtool', displayName: 'AppSys Devtool', icon: null },
      problems: []
    })
  })

  it('gives the default identity when adt is not an object', () => {
    expect(resolveAppIdentity({ adt: 'example' })).toEqual({
      identity: { name: 'appsys-devtool', displayName: 'AppSys Devtool', icon: null },
      problems: []
    })
  })

  it('takes valid settings', () => {
    expect(resolveAppIdentity({ adt: { displayName: 'Example Tool', name: 'example_tool-2', icon: '/assets/icon.svg' } })).toEqual({
      identity: { name: 'example_tool-2', displayName: 'Example Tool', icon: '/assets/icon.svg' },
      problems: []
    })
  })

  it('trims the display name', () => {
    expect(resolveAppIdentity({ adt: { displayName: '  Example Tool  ' } }).identity.displayName).toBe('Example Tool')
  })

  it.each([
    ['Example Tool', 'example-tool'],
    ['Équipe Démo', 'equipe-demo'],
    ['  --Example__Tool!!  2 ', 'example-tool-2']
  ])('names %j %j by default', (displayName, name) => {
    expect(resolveAppIdentity({ adt: { displayName } })).toEqual({
      identity: { name, displayName: displayName.trim(), icon: null },
      problems: []
    })
  })

  it('falls back to the default name when the display name holds no letter nor digit', () => {
    expect(resolveAppIdentity({ adt: { displayName: '!!!' } })).toEqual({
      identity: { name: 'appsys-devtool', displayName: '!!!', icon: null },
      problems: []
    })
  })

  it.each([
    ['a blank text', '   '],
    ['an empty text', ''],
    ['a text holding /', 'Example/Tool'],
    ['a number', 42],
    ['null', null]
  ])('keeps the default display name for %s', (_, displayName) => {
    expect(resolveAppIdentity({ adt: { displayName } })).toEqual({
      identity: { name: 'appsys-devtool', displayName: 'AppSys Devtool', icon: null },
      problems: [{ setting: 'adt.displayName', message: 'must be a text without /' }]
    })
  })

  it.each([
    ['uppercase letters', 'Example'],
    ['a leading hyphen', '-example'],
    ['a leading underscore', '_example'],
    ['spaces', 'example tool'],
    ['dots', 'example.dev'],
    ['an empty text', ''],
    ['a number', 42],
    ['null', null]
  ])('keeps the default name for a name holding %s', (_, name) => {
    expect(resolveAppIdentity({ adt: { displayName: 'Example Tool', name } })).toEqual({
      identity: { name: 'example-tool', displayName: 'Example Tool', icon: null },
      problems: [{ setting: 'adt.name', message: 'must hold lowercase letters, digits, - and _ only' }]
    })
  })

  it.each(['icon.svg', 'icon.png', 'icon.jpg', 'icon.jpeg', 'icon.icns', 'ICON.SVG', 'assets/icon.PNG'])('takes the icon %j', icon => {
    expect(resolveAppIdentity({ adt: { icon } })).toEqual({
      identity: { name: 'appsys-devtool', displayName: 'AppSys Devtool', icon },
      problems: []
    })
  })

  it.each([
    ['another extension', 'icon.gif'],
    ['no extension', 'icon'],
    ['a number', 42],
    ['null', null]
  ])('keeps the default icon for an icon with %s', (_, icon) => {
    expect(resolveAppIdentity({ adt: { icon } })).toEqual({
      identity: { name: 'appsys-devtool', displayName: 'AppSys Devtool', icon: null },
      problems: [{ setting: 'adt.icon', message: 'must be a .svg, .png, .jpg, .jpeg, .icns file' }]
    })
  })

  it('reports every invalid setting', () => {
    expect(resolveAppIdentity({ adt: { displayName: 'a/b', name: 'Bad Name', icon: 'icon.gif' } })).toEqual({
      identity: { name: 'appsys-devtool', displayName: 'AppSys Devtool', icon: null },
      problems: [
        { setting: 'adt.displayName', message: 'must be a text without /' },
        { setting: 'adt.name', message: 'must hold lowercase letters, digits, - and _ only' },
        { setting: 'adt.icon', message: 'must be a .svg, .png, .jpg, .jpeg, .icns file' }
      ]
    })
  })
})

describe('resolveDefaultConfigPaths', () => {
  it('lists the shared then the personal configuration of a folder', () => {
    expect(resolveDefaultConfigPaths('/example/config')).toEqual(['/example/config/config.yml', '/example/config/config.local.yml'])
  })

  it('uses the configuration folder by default', () => {
    vi.stubEnv(CONFIG_FOLDER_VARIABLE, '/example/config')

    expect(resolveDefaultConfigPaths()).toEqual(['/example/config/config.yml', '/example/config/config.local.yml'])
  })
})

describe('loadMergedConfig', () => {
  let folder: string

  beforeEach(async () => {
    folder = await makeTemporaryFolder()
  })

  it('merges the personal configuration over the shared one', async () => {
    const shared = await writeFile(folder, 'config.yml', 'adt:\n  name: shared\n  displayName: Shared\ncdn:\n  url: https://example.dev\n')
    const local = await writeFile(folder, 'config.local.yml', 'adt:\n  name: local\n')

    const { config, loadedPaths, sources, localPath } = await loadMergedConfig([shared, local])

    expect(config).toEqual({ adt: { name: 'local', displayName: 'Shared' }, cdn: { url: 'https://example.dev' } })
    expect(loadedPaths).toEqual([shared, local])
    expect(localPath).toBe(local)
    expect(sources).toEqual({
      [configSourceKey(['adt'])]: [shared, local],
      [configSourceKey(['adt', 'name'])]: [shared, local],
      [configSourceKey(['adt', 'displayName'])]: [shared],
      [configSourceKey(['cdn'])]: [shared],
      [configSourceKey(['cdn', 'url'])]: [shared]
    })
  })

  it.each([
    ['empty', ''],
    ['holding comments only', '# personal overrides\n']
  ])('loads a personal configuration that is %s', async (_, content) => {
    const shared = await writeFile(folder, 'config.yml', 'value: shared\n')
    const local = await writeFile(folder, 'config.local.yml', content)

    expect(await loadMergedConfig([shared, local])).toEqual({
      config: { value: 'shared' },
      loadedPaths: [shared, local],
      sources: { [configSourceKey(['value'])]: [shared] },
      localPath: local
    })
  })

  it('rejects an invalid personal configuration', async () => {
    const shared = await writeFile(folder, 'config.yml', 'value: shared\n')
    const local = await writeFile(folder, 'config.local.yml', 'value: [unclosed\n')

    await expect(loadMergedConfig([shared, local])).rejects.toThrow(local)
  })

  it('skips missing files', async () => {
    const shared = await writeFile(folder, 'config.yml', 'value: shared\n')
    const local = path.join(folder, 'config.local.yml')

    expect(await loadMergedConfig([shared, local])).toMatchObject({
      config: { value: 'shared' },
      loadedPaths: [shared],
      localPath: local
    })
  })

  it('gives an empty configuration when no file exists', async () => {
    expect(await loadMergedConfig([path.join(folder, 'config.yml')])).toEqual({
      config: {},
      loadedPaths: [],
      sources: {},
      localPath: null
    })
  })

  it('gives an empty configuration for no paths', async () => {
    expect(await loadMergedConfig([])).toEqual({ config: {}, loadedPaths: [], sources: {}, localPath: null })
  })

  it('gives the last personal override among the paths as the local path', async () => {
    const first = path.join(folder, 'first.local.yml')
    const second = path.join(folder, 'other/second.local.yml')

    expect((await loadMergedConfig([path.join(folder, 'config.yml'), first, second, path.join(folder, 'last.yml')])).localPath).toBe(second)
  })

  it('resolves relative and home paths of the files', async () => {
    const home = await makeTemporaryFolder()
    vi.stubEnv('HOME', home)
    const shared = await writeFile(home, 'settings/config.yml', 'value: home\n')
    const relative = path.relative(process.cwd(), await writeFile(folder, 'config.local.yml', 'local: true\n'))

    expect(await loadMergedConfig(['~/settings/config.yml', relative])).toMatchObject({
      config: { value: 'home', local: true },
      loadedPaths: [shared, path.join(folder, 'config.local.yml')],
      localPath: path.join(folder, 'config.local.yml')
    })
  })

  it('resolves folder paths of every file from the folder of the first file', async () => {
    const other = await makeTemporaryFolder()
    const shared = await writeFile(folder, 'config.yml', 'adt:\n  cacheDir: cache\n')
    const local = await writeFile(other, 'config.local.yml', 'workspace: workspace\n')

    expect((await loadMergedConfig([shared, local])).config).toEqual({
      adt: { cacheDir: path.join(folder, 'cache') },
      workspace: path.join(folder, 'workspace')
    })
  })

  it('resolves folder paths from the folder of the first file even when it is missing', async () => {
    const other = await makeTemporaryFolder()
    const local = await writeFile(other, 'config.local.yml', 'workspace: workspace\n')

    expect((await loadMergedConfig([path.join(folder, 'config.yml'), local])).config).toEqual({ workspace: path.join(folder, 'workspace') })
  })

  it('resolves section paths from the workspace of the merged configuration', async () => {
    const shared = await writeFile(folder, 'config.yml', [
      'sections:',
      '  api:',
      '    path: api',
      '  absolute:',
      '    path: /example/absolute',
      '  root: {}',
      '  broken: null',
      '  label: text',
      ''
    ].join('\n'))
    const local = await writeFile(folder, 'config.local.yml', 'workspace: /example/workspace\n')

    expect((await loadMergedConfig([shared, local])).config).toEqual({
      workspace: '/example/workspace',
      sections: {
        api: { path: '/example/workspace/api' },
        absolute: { path: '/example/absolute' },
        root: { path: '/example/workspace' },
        broken: null,
        label: 'text'
      }
    })
  })

  it('gives the sections declaring no path the sectionPath, resolved from the workspace', async () => {
    const home = await makeTemporaryFolder()
    vi.stubEnv('HOME', home)
    const shared = await writeFile(folder, 'config.yml', 'sectionPath: example/monorepo\nsections:\n  api: {}\n  web:\n    path: web\n')
    const local = await writeFile(folder, 'config.local.yml', 'workspace: ~/Workspace\n')

    expect((await loadMergedConfig([shared, local])).config).toEqual({
      workspace: path.join(home, 'Workspace'),
      sectionPath: 'example/monorepo',
      sections: {
        api: { path: path.join(home, 'Workspace/example/monorepo') },
        web: { path: path.join(home, 'Workspace/web') }
      }
    })
  })

  it('leaves section paths relative without a workspace', async () => {
    const shared = await writeFile(folder, 'config.yml', 'sections:\n  api:\n    path: api\n  root: {}\n')

    expect((await loadMergedConfig([shared])).config).toEqual({ sections: { api: { path: 'api' }, root: { path: '.' } } })
  })

  it('leaves the sectionPath relative without a workspace', async () => {
    const shared = await writeFile(folder, 'config.yml', 'sectionPath: example/monorepo\nsections:\n  api: {}\n')

    expect((await loadMergedConfig([shared])).config).toEqual({
      sectionPath: 'example/monorepo',
      sections: { api: { path: 'example/monorepo' } }
    })
  })

  it('resolves the sections brought by an include from the workspace', async () => {
    const repository = await makeTemporaryFolder()
    await writeFile(repository, '.devtool/sections.yml', 'sections:\n  api: {}\n  web:\n    path: other/web\n')
    const shared = await writeFile(folder, 'config.yml', [
      `workspace: ${path.dirname(repository)}`,
      `sectionPath: ${path.basename(repository)}`,
      `include: [ ${path.join(repository, '.devtool/*.yml')} ]`,
      ''
    ].join('\n'))

    expect((await loadMergedConfig([shared])).config.sections).toEqual({
      api: { path: repository },
      web: { path: path.join(path.dirname(repository), 'other/web') }
    })
  })

  it('loads the default configuration files of the configuration folder', async () => {
    vi.stubEnv(CONFIG_FOLDER_VARIABLE, folder)
    const shared = await writeFile(folder, 'config.yml', 'value: shared\n')
    const local = await writeFile(folder, 'config.local.yml', 'value: local\n')

    expect(await loadMergedConfig()).toMatchObject({
      config: { value: 'local' },
      loadedPaths: [shared, local],
      localPath: local
    })
  })
})
