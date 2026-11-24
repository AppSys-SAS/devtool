import { X509Certificate } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/
const COMMON_NAME = /(?:^|\n| \+ )CN=((?:\\.|[^\\\n+])+?)(?= \+ |\n|$)/
const ESCAPED_CHARACTER = /\\([0-9A-Fa-f]{2}|.)/g

/**
 * Decodes an attribute value of a distinguished name escaped as RFC 2253 does.
 * @param value - The escaped value, special characters behind a backslash and control characters as `\XX` hexadecimal.
 * @returns The value as it is in the certificate.
 */
function unescapeNameValue (value: string): string {
  return value.replace(ESCAPED_CHARACTER, (_, character: string) => character.length === 2 ? String.fromCharCode(Number.parseInt(character, 16)) : character)
}

/** What the first certificate of a PEM text tells. */
export interface CertificateInfo {
  /** End of its validity, ISO date. */
  expiresAt: string
  /** Common name of its issuer, or its whole subject when it has none. */
  issuer: string
}

/**
 * Reads the first certificate of a PEM text.
 * @param content - The PEM text.
 * @returns What the certificate tells, null when the text holds no readable certificate.
 */
export function readCertificate (content: string): CertificateInfo | null {
  const block = CERTIFICATE_BLOCK.exec(content)?.[0]
  if (!block) {
    return null
  }
  try {
    const certificate = new X509Certificate(block)
    const commonName = COMMON_NAME.exec(certificate.issuer)?.[1]
    const issuer = commonName ? unescapeNameValue(commonName) : certificate.issuer.replace(/\n/g, ', ')
    return { expiresAt: new Date(certificate.validTo).toISOString(), issuer }
  } catch {
    return null
  }
}

/** A value of an option of `lego run`: a value, a list of values repeating the option, or a switch. */
export type LegoOptionValue = string | number | boolean | (string | number)[]

/**
 * Builds the arguments of `lego run`, each option given as `--<name>`, its list values repeating it,
 * a true switch alone and a false one left out.
 * @param options - The options, by name without their dashes.
 * @returns The arguments, after `run`.
 */
export function legoRunArgs (options: Record<string, LegoOptionValue>): string[] {
  return Object.entries(options).flatMap(([name, value]) => {
    if (value === false) {
      return []
    }
    if (value === true) {
      return [`--${name}`]
    }
    return (Array.isArray(value) ? value : [value]).flatMap(item => [`--${name}`, String(item)])
  })
}

/**
 * Gives the files lego writes for a certificate in its storage folder.
 * @param storage - The folder given to lego as `--path`.
 * @param name - The certificate name given to lego as `--cert.name`.
 * @returns The certificate and private key files.
 */
export function legoCertificateFiles (storage: string, name: string): { crt: string, key: string } {
  const base = path.join(storage, 'certificates', name.replaceAll('*', '_'))
  return { crt: `${base}.crt`, key: `${base}.key` }
}

/**
 * Copies a certificate and its private key where they are served, each written whole before
 * replacing the previous one, the key readable by its owner only.
 * @param from - The new certificate and key files.
 * @param to - The certificate and key files served.
 */
export async function installCertificateFiles (from: { crt: string, key: string }, to: { crt: string, key: string }): Promise<void> {
  for (const [source, target, mode] of [[from.crt, to.crt, 0o644], [from.key, to.key, 0o600]] as const) {
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.tmp`
    await fs.copyFile(source, temporary)
    await fs.chmod(temporary, mode)
    await fs.rename(temporary, target)
  }
}
