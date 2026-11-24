import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { originUrl, repositoryOf } from '../../src/repository.js'

describe('repositoryOf', () => {
  describe('scp-like remotes', () => {
    it('reads a remote with a .git suffix', () => {
      expect(repositoryOf('git@github.com:example/devtool.git'))
        .toEqual({ host: 'github.com', path: 'example/devtool', webUrl: 'https://github.com/example/devtool' })
    })

    it('reads a remote without a .git suffix', () => {
      expect(repositoryOf('git@gitlab.example.dev:team/app'))
        .toEqual({ host: 'gitlab.example.dev', path: 'team/app', webUrl: 'https://gitlab.example.dev/team/app' })
    })

    it('reads nested groups', () => {
      expect(repositoryOf('git@gitlab.example.dev:group/sub/deeper/app.git'))
        .toEqual({ host: 'gitlab.example.dev', path: 'group/sub/deeper/app', webUrl: 'https://gitlab.example.dev/group/sub/deeper/app' })
    })

    it('accepts any user name', () => {
      expect(repositoryOf('deploy-bot.1@git.example.dev:team/app.git'))
        .toEqual({ host: 'git.example.dev', path: 'team/app', webUrl: 'https://git.example.dev/team/app' })
    })

    it.each([
      { name: 'a leading slash', url: 'git@git.example.dev:/team/app.git' },
      { name: 'several leading slashes', url: 'git@git.example.dev://team/app.git' },
      { name: 'a trailing slash', url: 'git@git.example.dev:team/app/' },
      { name: 'a trailing slash after .git', url: 'git@git.example.dev:team/app.git/' },
      { name: 'several trailing slashes', url: 'git@git.example.dev:team/app.git///' },
      { name: 'a .git segment', url: 'git@git.example.dev:team/app/.git' },
      { name: 'a .git segment and a trailing slash', url: 'git@git.example.dev:team/app/.git/' }
    ])('drops $name', ({ url }) => {
      expect(repositoryOf(url))
        .toEqual({ host: 'git.example.dev', path: 'team/app', webUrl: 'https://git.example.dev/team/app' })
    })

    it('removes a single .git suffix only', () => {
      expect(repositoryOf('git@git.example.dev:team/app.git.git')?.path).toBe('team/app.git')
    })

    it('keeps .git when it is not a suffix', () => {
      expect(repositoryOf('git@git.example.dev:team/app.github')?.path).toBe('team/app.github')
    })

    it('reads an IPv6 host', () => {
      expect(repositoryOf('git@[::1]:team/app.git'))
        .toEqual({ host: '[::1]', path: 'team/app', webUrl: 'https://[::1]/team/app' })
    })

    it('reads a full IPv6 host', () => {
      expect(repositoryOf('git@[2001:db8::42]:group/sub/app'))
        .toEqual({ host: '[2001:db8::42]', path: 'group/sub/app', webUrl: 'https://[2001:db8::42]/group/sub/app' })
    })

    it('reads a numeric first segment as a path rather than a port', () => {
      expect(repositoryOf('git@git.example.dev:2222/app.git'))
        .toEqual({ host: 'git.example.dev', path: '2222/app', webUrl: 'https://git.example.dev/2222/app' })
    })

    it.each([
      { name: 'a single segment', url: 'git@git.example.dev:app.git' },
      { name: 'a single segment between slashes', url: 'git@git.example.dev:/app.git/' },
      { name: 'an empty path', url: 'git@git.example.dev:' },
      { name: 'a path made of slashes', url: 'git@git.example.dev:///' },
      { name: 'an unclosed IPv6 host', url: 'git@[::1:team/app.git' },
      { name: 'a bracket inside the host', url: 'git@git[1].example.dev:team/app.git' }
    ])('ignores $name', ({ url }) => {
      expect(repositoryOf(url)).toBeNull()
    })
  })

  describe('web addresses', () => {
    it('reads an https address', () => {
      expect(repositoryOf('https://github.com/example/devtool'))
        .toEqual({ host: 'github.com', path: 'example/devtool', webUrl: 'https://github.com/example/devtool' })
    })

    it('reads an https clone address with a .git suffix', () => {
      expect(repositoryOf('https://github.com/example/devtool.git'))
        .toEqual({ host: 'github.com', path: 'example/devtool', webUrl: 'https://github.com/example/devtool' })
    })

    it('keeps the http protocol and a custom port', () => {
      expect(repositoryOf('http://git.example.dev:8080/team/app/'))
        .toEqual({ host: 'git.example.dev:8080', path: 'team/app', webUrl: 'http://git.example.dev:8080/team/app' })
    })

    it('keeps a custom https port', () => {
      expect(repositoryOf('https://git.example.dev:8443/team/app.git'))
        .toEqual({ host: 'git.example.dev:8443', path: 'team/app', webUrl: 'https://git.example.dev:8443/team/app' })
    })

    it.each([
      { name: 'https', url: 'https://git.example.dev:443/team/app', webUrl: 'https://git.example.dev/team/app' },
      { name: 'http', url: 'http://git.example.dev:80/team/app', webUrl: 'http://git.example.dev/team/app' }
    ])('drops the default $name port', ({ url, webUrl }) => {
      expect(repositoryOf(url)).toEqual({ host: 'git.example.dev', path: 'team/app', webUrl })
    })

    it('keeps the https port on an http address', () => {
      expect(repositoryOf('http://git.example.dev:443/team/app')?.host).toBe('git.example.dev:443')
    })

    it('reads nested groups', () => {
      expect(repositoryOf('https://gitlab.example.dev/group/sub/deeper/app.git'))
        .toEqual({ host: 'gitlab.example.dev', path: 'group/sub/deeper/app', webUrl: 'https://gitlab.example.dev/group/sub/deeper/app' })
    })

    it('leaves credentials out of the repository', () => {
      expect(repositoryOf('https://user:secret@git.example.dev/team/app.git'))
        .toEqual({ host: 'git.example.dev', path: 'team/app', webUrl: 'https://git.example.dev/team/app' })
    })

    it('leaves the query and the fragment out of the repository', () => {
      expect(repositoryOf('https://git.example.dev/team/app?tab=readme#install'))
        .toEqual({ host: 'git.example.dev', path: 'team/app', webUrl: 'https://git.example.dev/team/app' })
    })

    it('normalizes the case of the protocol and the host', () => {
      expect(repositoryOf('HTTPS://Git.Example.DEV/Team/App'))
        .toEqual({ host: 'git.example.dev', path: 'Team/App', webUrl: 'https://git.example.dev/Team/App' })
    })

    it('reads an ip address host', () => {
      expect(repositoryOf('http://192.168.1.10:3000/team/app.git'))
        .toEqual({ host: '192.168.1.10:3000', path: 'team/app', webUrl: 'http://192.168.1.10:3000/team/app' })
    })

    it('keeps encoded characters of the path', () => {
      expect(repositoryOf('https://git.example.dev/team/my%20app')?.path).toBe('team/my%20app')
    })

    it.each([
      { name: 'a trailing slash', url: 'https://git.example.dev/team/app/' },
      { name: 'a trailing slash after .git', url: 'https://git.example.dev/team/app.git/' },
      { name: 'several trailing slashes', url: 'https://git.example.dev/team/app.git///' },
      { name: 'a .git segment', url: 'https://git.example.dev/team/app/.git' },
      { name: 'a .git segment and a trailing slash', url: 'https://git.example.dev/team/app/.git/' }
    ])('drops $name', ({ url }) => {
      expect(repositoryOf(url)?.path).toBe('team/app')
    })

    it('gives a web address without a trailing slash for a .git segment', () => {
      expect(repositoryOf('https://git.example.dev/team/app/.git'))
        .toEqual({ host: 'git.example.dev', path: 'team/app', webUrl: 'https://git.example.dev/team/app' })
    })

    it.each([
      { name: 'no path', url: 'https://git.example.dev' },
      { name: 'a root path', url: 'https://git.example.dev/' },
      { name: 'a single segment', url: 'https://github.com/example' },
      { name: 'a single segment with a trailing slash', url: 'https://github.com/example/' },
      { name: 'a single segment with a .git suffix', url: 'https://github.com/example.git' }
    ])('ignores an address with $name', ({ url }) => {
      expect(repositoryOf(url)).toBeNull()
    })
  })

  describe('ssh urls', () => {
    it('reads an ssh url without its port in the web address', () => {
      expect(repositoryOf('ssh://git@gitlab.example.dev:2222/group/sub/app.git'))
        .toEqual({ host: 'gitlab.example.dev', path: 'group/sub/app', webUrl: 'https://gitlab.example.dev/group/sub/app' })
    })

    it('reads an ssh url without a user', () => {
      expect(repositoryOf('ssh://git.example.dev/team/app.git'))
        .toEqual({ host: 'git.example.dev', path: 'team/app', webUrl: 'https://git.example.dev/team/app' })
    })

    it('reads a git+ssh url', () => {
      expect(repositoryOf('git+ssh://git@github.com/example/devtool'))
        .toEqual({ host: 'github.com', path: 'example/devtool', webUrl: 'https://github.com/example/devtool' })
    })

    it('reads a git+ssh url without its port in the web address', () => {
      expect(repositoryOf('git+ssh://git@git.example.dev:7999/team/app.git/'))
        .toEqual({ host: 'git.example.dev', path: 'team/app', webUrl: 'https://git.example.dev/team/app' })
    })

    it('accepts an upper case protocol', () => {
      expect(repositoryOf('GIT+SSH://git@git.example.dev/team/app.git'))
        .toEqual({ host: 'git.example.dev', path: 'team/app', webUrl: 'https://git.example.dev/team/app' })
    })

    it.each([
      { name: 'ssh', url: 'ssh://git@git.example.dev:2222/app.git' },
      { name: 'git+ssh', url: 'git+ssh://git@git.example.dev/' }
    ])('ignores an $name url naming no repository', ({ url }) => {
      expect(repositoryOf(url)).toBeNull()
    })
  })

  describe('surrounding whitespace', () => {
    it.each([
      { name: 'an scp-like remote', url: '  git@git.example.dev:team/app.git\n' },
      { name: 'a web address', url: '\thttps://git.example.dev/team/app\n' },
      { name: 'an ssh url', url: ' ssh://git@git.example.dev/team/app.git ' }
    ])('is trimmed from $name', ({ url }) => {
      expect(repositoryOf(url))
        .toEqual({ host: 'git.example.dev', path: 'team/app', webUrl: 'https://git.example.dev/team/app' })
    })
  })

  describe('unsupported addresses', () => {
    it.each([
      { name: 'an empty string', url: '' },
      { name: 'whitespace only', url: ' \n\t ' },
      { name: 'plain text', url: 'not a url' },
      { name: 'a relative path', url: 'team/app' },
      { name: 'an absolute path', url: '/srv/git/team/app.git' },
      { name: 'an e-mail address', url: 'user@example.dev' },
      { name: 'a mailto address', url: 'mailto:user@example.dev' },
      { name: 'a file url', url: 'file:///tmp/repo.git' },
      { name: 'an ftp url', url: 'ftp://git.example.dev/team/app.git' },
      { name: 'a git+https url', url: 'git+https://git.example.dev/team/app.git' },
      { name: 'an scp-like remote with whitespace in its user', url: 'git user@git.example.dev:team/app.git' }
    ])('ignores $name', ({ url }) => {
      expect(repositoryOf(url)).toBeNull()
    })
  })
})

describe('originUrl', () => {
  const folders: string[] = []

  /**
   * Creates an empty temporary folder, removed after each test.
   * @returns The absolute path of the folder.
   */
  async function temporaryFolder (): Promise<string> {
    const folder = await mkdtemp(join(tmpdir(), 'devtool-git-'))
    folders.push(folder)
    return folder
  }

  /**
   * Runs git in a folder.
   * @param folder - The folder git runs in.
   * @param args - The arguments of git.
   */
  function git (folder: string, ...args: string[]): void {
    execFileSync('git', ['-C', folder, ...args], { stdio: 'ignore' })
  }

  /**
   * Creates a temporary git repository with remotes.
   * @param remotes - The address of each remote, by remote name.
   * @returns The absolute path of the working copy.
   */
  async function repository (remotes: Record<string, string> = {}): Promise<string> {
    const folder = await temporaryFolder()
    git(folder, 'init', '--quiet')
    for (const [name, url] of Object.entries(remotes)) {
      git(folder, 'remote', 'add', name, url)
    }
    return folder
  }

  afterEach(async () => {
    await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
  })

  it('gives the address of the origin remote', async () => {
    const folder = await repository({ origin: 'git@git.example.dev:team/app.git' })

    expect(originUrl(folder)).toBe('git@git.example.dev:team/app.git')
  })

  it('gives an https origin address', async () => {
    const folder = await repository({ origin: 'https://git.example.dev/team/app.git' })

    expect(originUrl(folder)).toBe('https://git.example.dev/team/app.git')
  })

  it('gives the origin address among other remotes', async () => {
    const folder = await repository({
      upstream: 'git@git.example.dev:upstream/app.git',
      origin: 'git@git.example.dev:fork/app.git'
    })

    expect(originUrl(folder)).toBe('git@git.example.dev:fork/app.git')
  })

  it('gives the fetch address when the push address differs', async () => {
    const folder = await repository({ origin: 'https://git.example.dev/team/app.git' })
    git(folder, 'remote', 'set-url', '--push', 'origin', 'git@git.example.dev:team/app.git')

    expect(originUrl(folder)).toBe('https://git.example.dev/team/app.git')
  })

  it('gives the origin address from a subfolder of the working copy', async () => {
    const folder = await repository({ origin: 'git@git.example.dev:team/app.git' })
    const subfolder = join(folder, 'src', 'nested')
    await mkdir(subfolder, { recursive: true })

    expect(originUrl(subfolder)).toBe('git@git.example.dev:team/app.git')
  })

  it('gives an address repositoryOf reads', async () => {
    const folder = await repository({ origin: 'ssh://git@git.example.dev:2222/team/app.git' })

    expect(repositoryOf(originUrl(folder) ?? ''))
      .toEqual({ host: 'git.example.dev', path: 'team/app', webUrl: 'https://git.example.dev/team/app' })
  })

  it('gives null for a repository without remotes', async () => {
    expect(originUrl(await repository())).toBeNull()
  })

  it('gives null for a repository without an origin remote', async () => {
    const folder = await repository({ upstream: 'git@git.example.dev:team/app.git' })

    expect(originUrl(folder)).toBeNull()
  })

  it('gives null for a folder that is not a repository', async () => {
    expect(originUrl(await temporaryFolder())).toBeNull()
  })

  it('gives null for a folder that does not exist', async () => {
    const folder = await temporaryFolder()

    expect(originUrl(join(folder, 'missing'))).toBeNull()
  })
})
