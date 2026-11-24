import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installCertificateFiles, legoCertificateFiles, legoRunArgs, readCertificate } from '../../src/certificate.js'

const execFileAsync = promisify(execFile)

const DAY = 24 * 60 * 60 * 1000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

let folder: string
let key: string
let created = 0

/**
 * Runs openssl in the folder of the certificates.
 * @param args - The arguments of openssl.
 * @returns What openssl printed.
 */
async function openssl (...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('openssl', args, { cwd: folder })
  return stdout
}

/**
 * Creates a certificate with openssl, all certificates sharing the same private key.
 * @param subject - The subject, as `-subj` of openssl reads it.
 * @param days - The number of days the certificate is valid from now.
 * @param issuer - The file of the certificate signing it, the certificate signing itself when omitted.
 * @returns The file of the certificate and its PEM text.
 */
async function createCertificate (subject: string, days: number, issuer?: string): Promise<{ file: string, pem: string }> {
  created += 1
  const file = path.join(folder, `certificate-${created}.crt`)
  if (issuer) {
    const request = path.join(folder, `request-${created}.csr`)
    await openssl('req', '-new', '-utf8', '-key', key, '-subj', subject, '-out', request)
    await openssl('x509', '-req', '-in', request, '-CA', issuer, '-CAkey', key, '-set_serial', String(created), '-days', String(days), '-out', file)
  } else {
    await openssl('req', '-x509', '-utf8', '-key', key, '-subj', subject, '-days', String(days), '-out', file)
  }
  return { file, pem: await fs.readFile(file, 'utf8') }
}

/**
 * Gives the end of validity of a certificate file as openssl prints it.
 * @param file - The certificate file.
 * @returns The end of validity, ISO date.
 */
async function opensslExpiry (file: string): Promise<string> {
  const output = await openssl('x509', '-in', file, '-noout', '-enddate')
  const [, month, day, time, year] = /notAfter=(\w{3}) +(\d+) (\d\d:\d\d:\d\d) (\d{4}) GMT/.exec(output) ?? []
  return `${year}-${String(MONTHS.indexOf(month) + 1).padStart(2, '0')}-${day.padStart(2, '0')}T${time}.000Z`
}

/**
 * Gives the permissions of a file.
 * @param file - The file.
 * @returns Its permission bits.
 */
async function modeOf (file: string): Promise<number> {
  return (await fs.stat(file)).mode & 0o777
}

/**
 * Writes a file with exact permissions, creating its folder.
 * @param file - The file to write.
 * @param content - Its content.
 * @param mode - Its permissions.
 */
async function writeFile (file: string, content: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
  await fs.chmod(file, mode)
}

/**
 * Tells whether a path exists.
 * @param target - The path to check.
 * @returns Whether something exists at the path.
 */
async function exists (target: string): Promise<boolean> {
  return fs.access(target).then(() => true, () => false)
}

beforeAll(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'certificate-spec-'))
  key = path.join(folder, 'private-key')
  await openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key)
})

afterAll(async () => {
  await fs.rm(folder, { recursive: true, force: true })
})

describe('readCertificate', () => {
  describe('expiry', () => {
    it.each([1, 30, 825, 36500])('gives the end of validity of a certificate valid %i days', async days => {
      const before = Date.now()
      const { file, pem } = await createCertificate('/CN=example.dev', days)
      const after = Date.now()

      const info = readCertificate(pem)

      expect(info?.expiresAt).toBe(await opensslExpiry(file))
      const expiresAt = Date.parse(info!.expiresAt)
      expect(expiresAt).toBeGreaterThanOrEqual(before - 1000 + days * DAY)
      expect(expiresAt).toBeLessThanOrEqual(after + days * DAY)
    })

    it('gives the expiry as a full ISO date in UTC', async () => {
      const { pem } = await createCertificate('/CN=example.dev', 30)

      expect(readCertificate(pem)?.expiresAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/)
    })
  })

  describe('issuer', () => {
    it.each([
      ['/CN=Example CA', 'Example CA'],
      ['/C=FR/O=Example/OU=Certificates/CN=Example CA', 'Example CA'],
      ['/CN=Example CA/O=Example/C=FR', 'Example CA'],
      ['/O=CN=Example Fake CA/CN=Example CA', 'Example CA'],
      ['/CN=First Example CA/CN=Second Example CA', 'First Example CA'],
      ['/C=FR/O=Example, Inc./CN=Example, Inc. CA', 'Example, Inc. CA'],
      ['/CN=#1 "Example"; <CA> \\+ Root\\\\ = ', '#1 "Example"; <CA> + Root\\ = '],
      ['/CN= Example CA', ' Example CA'],
      ['/CN=Exämple Çertificates € CA', 'Exämple Çertificates € CA'],
      ['/CN=Example\tCA', 'Example\tCA'],
      ['/O=Example+CN=Example CA/C=FR', 'Example CA'],
      ['/CN=Example CA+OU=Certificates/C=FR', 'Example CA']
    ])('gives the common name of the issuer %s', async (subject, issuer) => {
      const { pem } = await createCertificate(subject, 30)

      expect(readCertificate(pem)?.issuer).toBe(issuer)
    })

    it.each([
      ['/C=FR/O=Example', 'C=FR, O=Example'],
      ['/C=FR/O=Example, Inc./OU=Certificates', 'C=FR, O=Example\\, Inc., OU=Certificates'],
      ['/O=Example+OU=Certificates/C=FR', 'O=Example + OU=Certificates, C=FR']
    ])('gives the whole name of an issuer %s without common name', async (subject, issuer) => {
      const { pem } = await createCertificate(subject, 30)

      expect(readCertificate(pem)?.issuer).toBe(issuer)
    })

    it('gives the issuer rather than the subject of a signed certificate', async () => {
      const authority = await createCertificate('/O=Example/CN=Example Root CA', 3650)
      const { pem } = await createCertificate('/CN=example.dev', 30, authority.file)

      expect(readCertificate(pem)?.issuer).toBe('Example Root CA')
    })
  })

  describe('chains', () => {
    let authority: { file: string, pem: string }
    let leaf: { file: string, pem: string }

    beforeAll(async () => {
      authority = await createCertificate('/O=Example/CN=Example Root CA', 3650)
      leaf = await createCertificate('/CN=www.example.dev', 90, authority.file)
    })

    it('reads the first certificate of a chain', async () => {
      expect(readCertificate(`${leaf.pem}${authority.pem}`)).toEqual({ expiresAt: await opensslExpiry(leaf.file), issuer: 'Example Root CA' })
    })

    it('reads the first certificate whatever the order of the chain', async () => {
      expect(readCertificate(`${authority.pem}${leaf.pem}`)).toEqual({ expiresAt: await opensslExpiry(authority.file), issuer: 'Example Root CA' })
    })

    it('does not fall back to a later certificate when the first one is unreadable', () => {
      const lines = leaf.pem.split('\n')
      const truncated = [...lines.slice(0, 2), ...lines.slice(3)].join('\n')

      expect(readCertificate(`${truncated}${authority.pem}`)).toBeNull()
    })
  })

  describe('PEM text', () => {
    let certificate: { file: string, pem: string }
    let expected: { expiresAt: string, issuer: string }

    beforeAll(async () => {
      certificate = await createCertificate('/CN=example.dev', 30)
      expected = { expiresAt: await opensslExpiry(certificate.file), issuer: 'example.dev' }
    })

    it('reads a certificate surrounded by other text', () => {
      expect(readCertificate(`subject=CN=example.dev\n\n${certificate.pem}\nend of file\n`)).toEqual(expected)
    })

    it('reads a certificate without its final line break', () => {
      expect(readCertificate(certificate.pem.trimEnd())).toEqual(expected)
    })

    it('reads a certificate with Windows line breaks', () => {
      expect(readCertificate(certificate.pem.replace(/\n/g, '\r\n'))).toEqual(expected)
    })

    it('reads the certificate following a private key', async () => {
      const privateKey = await fs.readFile(key, 'utf8')

      expect(readCertificate(`${privateKey}${certificate.pem}`)).toEqual(expected)
    })

    it('gives null for a private key alone', async () => {
      expect(readCertificate(await fs.readFile(key, 'utf8'))).toBeNull()
    })

    it('gives null for a truncated certificate', () => {
      const lines = certificate.pem.split('\n')

      expect(readCertificate([...lines.slice(0, 2), ...lines.slice(3)].join('\n'))).toBeNull()
    })

    it('gives null for a certificate whose content is altered', () => {
      const lines = certificate.pem.split('\n')
      lines[1] = lines[1].replace(/^.{8}/, 'AAAAAAAA')

      expect(readCertificate(lines.join('\n'))).toBeNull()
    })

    it('gives null for a certificate without its end marker', () => {
      expect(readCertificate(certificate.pem.replace('-----END CERTIFICATE-----', ''))).toBeNull()
    })

    it.each([
      ['an empty text', ''],
      ['a text without certificate', 'not a certificate'],
      ['a begin marker alone', '-----BEGIN CERTIFICATE-----'],
      ['markers in the wrong order', '-----END CERTIFICATE-----\nMIIB\n-----BEGIN CERTIFICATE-----'],
      ['an empty block', '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----'],
      ['a block of text', '-----BEGIN CERTIFICATE-----\nnot base64 at all\n-----END CERTIFICATE-----'],
      ['a block of base64 that is not a certificate', '-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----']
    ])('gives null for %s', (_, content) => {
      expect(readCertificate(content)).toBeNull()
    })
  })
})

describe('legoRunArgs', () => {
  it('gives no arguments without options', () => {
    expect(legoRunArgs({})).toEqual([])
  })

  it('gives a string option followed by its value', () => {
    expect(legoRunArgs({ 'cert.name': 'example.dev' })).toEqual(['--cert.name', 'example.dev'])
  })

  it.each([
    [0, '0'],
    [42, '42'],
    [-1, '-1'],
    [1.5, '1.5']
  ])('gives a number option followed by its value %s', (value, text) => {
    expect(legoRunArgs({ 'dns.propagation.wait': value })).toEqual(['--dns.propagation.wait', text])
  })

  it('keeps an empty string value', () => {
    expect(legoRunArgs({ email: '' })).toEqual(['--email', ''])
  })

  it('keeps a value with spaces or dashes as one argument', () => {
    expect(legoRunArgs({ 'user-agent': 'example dev', 'key-type': '--ec256' })).toEqual(['--user-agent', 'example dev', '--key-type', '--ec256'])
  })

  it('gives a true switch alone', () => {
    expect(legoRunArgs({ 'accept-tos': true })).toEqual(['--accept-tos'])
  })

  it('leaves a false switch out', () => {
    expect(legoRunArgs({ 'accept-tos': false })).toEqual([])
  })

  it('repeats the option for each value of a list', () => {
    expect(legoRunArgs({ domains: ['example.dev', '*.example.dev', 8443] })).toEqual(['--domains', 'example.dev', '--domains', '*.example.dev', '--domains', '8443'])
  })

  it('leaves an empty list out', () => {
    expect(legoRunArgs({ domains: [] })).toEqual([])
  })

  it('keeps the order of the options', () => {
    expect(legoRunArgs({
      'email': 'admin@example.dev',
      'accept-tos': true,
      'domains': ['example.dev', '*.example.dev'],
      'dns': 'route53',
      'pem': false,
      'dns.resolvers': ['1.1.1.1:53'],
      'cert.timeout': 30
    })).toEqual([
      '--email', 'admin@example.dev',
      '--accept-tos',
      '--domains', 'example.dev',
      '--domains', '*.example.dev',
      '--dns', 'route53',
      '--dns.resolvers', '1.1.1.1:53',
      '--cert.timeout', '30'
    ])
  })
})

describe('legoCertificateFiles', () => {
  it('gives the certificate and key of a name in the certificates folder of the storage', () => {
    expect(legoCertificateFiles('/var/lib/lego', 'example.dev')).toEqual({
      crt: '/var/lib/lego/certificates/example.dev.crt',
      key: '/var/lib/lego/certificates/example.dev.key'
    })
  })

  it('replaces the wildcard of a name by an underscore', () => {
    expect(legoCertificateFiles('/var/lib/lego', '*.example.dev')).toEqual({
      crt: '/var/lib/lego/certificates/_.example.dev.crt',
      key: '/var/lib/lego/certificates/_.example.dev.key'
    })
  })

  it('replaces every wildcard of a name', () => {
    expect(legoCertificateFiles('/var/lib/lego', '*.*.example.dev').crt).toBe('/var/lib/lego/certificates/_._.example.dev.crt')
  })

  it('keeps a relative storage relative', () => {
    expect(legoCertificateFiles('certs/lego', 'example.dev')).toEqual({
      crt: path.join('certs', 'lego', 'certificates', 'example.dev.crt'),
      key: path.join('certs', 'lego', 'certificates', 'example.dev.key')
    })
  })

  it('normalizes the storage folder', () => {
    expect(legoCertificateFiles('/var/lib/lego/', 'example.dev').crt).toBe('/var/lib/lego/certificates/example.dev.crt')
    expect(legoCertificateFiles('/var/lib/./other/../lego', 'example.dev').crt).toBe('/var/lib/lego/certificates/example.dev.crt')
  })
})

describe('installCertificateFiles', () => {
  let root: string
  let from: { crt: string, key: string }
  let to: { crt: string, key: string }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(folder, 'install-'))
    from = { crt: path.join(root, 'lego', 'example.dev.crt'), key: path.join(root, 'lego', 'example.dev.key') }
    to = { crt: path.join(root, 'served', 'certs', 'example.dev.crt'), key: path.join(root, 'served', 'private', 'example.dev.key') }
    await writeFile(from.crt, 'new certificate', 0o600)
    await writeFile(from.key, 'new key', 0o644)
  })

  it('copies the certificate and key, creating their folders', async () => {
    await installCertificateFiles(from, to)

    expect(await fs.readFile(to.crt, 'utf8')).toBe('new certificate')
    expect(await fs.readFile(to.key, 'utf8')).toBe('new key')
    expect(await fs.readFile(from.crt, 'utf8')).toBe('new certificate')
    expect(await fs.readFile(from.key, 'utf8')).toBe('new key')
  })

  it('makes the certificate readable by all and the key by its owner only', async () => {
    await installCertificateFiles(from, to)

    expect(await modeOf(to.crt)).toBe(0o644)
    expect(await modeOf(to.key)).toBe(0o600)
  })

  it('replaces the files served, whatever their permissions', async () => {
    await writeFile(to.crt, 'old certificate', 0o600)
    await writeFile(to.key, 'old key', 0o644)

    await installCertificateFiles(from, to)

    expect(await fs.readFile(to.crt, 'utf8')).toBe('new certificate')
    expect(await fs.readFile(to.key, 'utf8')).toBe('new key')
    expect(await modeOf(to.crt)).toBe(0o644)
    expect(await modeOf(to.key)).toBe(0o600)
  })

  it('replaces each file served by a new one instead of rewriting it', async () => {
    await writeFile(to.crt, 'old certificate', 0o644)
    await writeFile(to.key, 'old key', 0o600)
    await fs.link(to.crt, path.join(root, 'previous.crt'))
    await fs.link(to.key, path.join(root, 'previous.key'))

    await installCertificateFiles(from, to)

    expect(await fs.readFile(path.join(root, 'previous.crt'), 'utf8')).toBe('old certificate')
    expect(await fs.readFile(path.join(root, 'previous.key'), 'utf8')).toBe('old key')
  })

  it('leaves no temporary file behind', async () => {
    await installCertificateFiles(from, to)
    await installCertificateFiles(from, to)

    expect(await fs.readdir(path.dirname(to.crt))).toEqual(['example.dev.crt'])
    expect(await fs.readdir(path.dirname(to.key))).toEqual(['example.dev.key'])
  })

  it('serves the certificate and key from one folder', async () => {
    const served = { crt: path.join(root, 'served', 'example.dev.crt'), key: path.join(root, 'served', 'example.dev.key') }

    await installCertificateFiles(from, served)

    expect((await fs.readdir(path.join(root, 'served'))).sort()).toEqual(['example.dev.crt', 'example.dev.key'])
  })

  it('fails without touching the files served when the certificate is missing', async () => {
    await writeFile(to.crt, 'old certificate', 0o644)
    await writeFile(to.key, 'old key', 0o600)
    await fs.rm(from.crt)

    await expect(installCertificateFiles(from, to)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(to.crt, 'utf8')).toBe('old certificate')
    expect(await fs.readFile(to.key, 'utf8')).toBe('old key')
  })

  it('installs the certificate before failing on a missing key', async () => {
    await writeFile(to.key, 'old key', 0o600)
    await fs.rm(from.key)

    await expect(installCertificateFiles(from, to)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(to.crt, 'utf8')).toBe('new certificate')
    expect(await fs.readFile(to.key, 'utf8')).toBe('old key')
    expect(await exists(`${to.key}.${process.pid}.tmp`)).toBe(false)
  })
})
