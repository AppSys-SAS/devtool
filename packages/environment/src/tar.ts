import { BufferedReader } from './archive.js'

/** A regular file of a tar archive; its body must be read before the next entry is. */
export interface TarEntry {
  /** Its path relative to the archived folder, without the `./` the archive writes before it. */
  name: string
  size: number
  /** Last change, written to the archive; the current date when missing. */
  mtime?: Date
  body: AsyncIterable<Buffer>
}

const BLOCK = 512
const MAX_CHUNK = 64 * 1024
const USTAR_NAME_BYTES = 100
const MAX_OCTAL_SIZE = 8 ** 11
const REGULAR_TYPES = new Set(['0', '\0', '7'])

/**
 * Gives the number of padding bytes completing a body to a whole block.
 *
 * @param size - The size of the body.
 * @returns The padding size.
 */
function paddingOf (size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK
}

/**
 * Reads a NUL-terminated text field of a header.
 *
 * @param header - The header block.
 * @param offset - The start of the field.
 * @param length - The length of the field.
 * @returns The text.
 */
function textField (header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return field.toString('utf-8', 0, end < 0 ? length : end)
}

/**
 * Reads a numeric field of a header, octal or, for large values, base-256.
 *
 * @param header - The header block.
 * @param offset - The start of the field.
 * @param length - The length of the field.
 * @returns The number.
 */
function numberField (header: Buffer, offset: number, length: number): number {
  if ((header[offset] & 0x80) !== 0) {
    let value = header[offset] & 0x7f
    for (let index = offset + 1; index < offset + length; index += 1) {
      value = value * 256 + header[index]
    }
    return value
  }
  const text = textField(header, offset, length).trim()
  return text === '' ? 0 : Number.parseInt(text, 8)
}

/**
 * Computes the checksum of a header, its checksum field counted as spaces.
 *
 * @param header - The header block.
 * @returns The checksum.
 */
function checksumOf (header: Buffer): number {
  let sum = 0
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index]
  }
  return sum
}

/**
 * Reads the records of a PAX extended header, `<length> <key>=<value>\n`.
 *
 * @param data - The body of the extended header.
 * @returns The values by key.
 */
function parsePax (data: Buffer): Map<string, string> {
  const records = new Map<string, string>()
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    const length = Number.parseInt(data.toString('utf-8', offset, space), 10)
    if (space < 0 || !Number.isSafeInteger(length) || length <= 0) {
      break
    }
    const record = data.toString('utf-8', space + 1, offset + length - 1)
    const equals = record.indexOf('=')
    records.set(record.slice(0, equals), record.slice(equals + 1))
    offset += length
  }
  return records
}

/**
 * Strips the `./` the tar command writes before each path of an archive of a folder.
 *
 * @param name - The path in the archive.
 * @returns The path relative to the archived folder.
 */
function relativeName (name: string): string {
  return name.startsWith('./') ? name.slice(2) : name
}

/**
 * Reads the regular files of a tar archive, ustar, GNU or PAX, other entries being skipped.
 *
 * @param source - The uncompressed archive.
 * @returns The files, in their order in the archive.
 */
export async function* readTar (source: AsyncIterable<Buffer>): AsyncGenerator<TarEntry> {
  const iterator = source[Symbol.asyncIterator]()
  const reader = new BufferedReader(iterator)
  try {
    if (await reader.atEnd()) {
      throw new Error('not a tar archive')
    }
    yield* readEntries(reader)
  } finally {
    await iterator.return?.()
  }
}

/**
 * Reads the regular files of a tar archive up to its end blocks or the end of its bytes.
 *
 * @param reader - The archive, positioned on a header block.
 * @returns The files, in their order in the archive.
 */
async function* readEntries (reader: BufferedReader): AsyncGenerator<TarEntry> {
  let longName: string | null = null
  let pax = new Map<string, string>()
  while (!(await reader.atEnd())) {
    const header = await reader.read(BLOCK)
    if (header.every(byte => byte === 0)) {
      return
    }
    if (numberField(header, 148, 8) !== checksumOf(header)) {
      throw new Error('not a tar archive')
    }

    const type = String.fromCharCode(header[156])
    if (type === 'L' || type === 'x' || type === 'g') {
      const dataSize = numberField(header, 124, 12)
      const data = await reader.read(dataSize)
      await reader.read(paddingOf(dataSize))
      if (type === 'L') {
        longName = textField(data, 0, data.length)
      } else if (type === 'x') {
        pax = parsePax(data)
      }
      continue
    }

    const size = Number(pax.get('size') ?? numberField(header, 124, 12))
    const prefix = textField(header, 257, 6) === 'ustar' ? textField(header, 345, 155) : ''
    const name = relativeName(longName ?? pax.get('path') ?? (prefix ? `${prefix}/${textField(header, 0, USTAR_NAME_BYTES)}` : textField(header, 0, USTAR_NAME_BYTES)))
    longName = null
    pax = new Map()
    let remaining = size
    if (REGULAR_TYPES.has(type) && name !== '') {
      const body = async function* (): AsyncGenerator<Buffer> {
        while (remaining > 0) {
          const chunk = await reader.read(Math.min(remaining, MAX_CHUNK))
          remaining -= chunk.length
          yield chunk
        }
      }
      yield { name, size, body: body() }
    }
    while (remaining > 0) {
      remaining -= (await reader.read(Math.min(remaining, MAX_CHUNK))).length
    }
    await reader.read(paddingOf(size))
  }
}

/**
 * Writes an octal field of a header, NUL-terminated.
 *
 * @param header - The header block.
 * @param offset - The start of the field.
 * @param length - The length of the field.
 * @param value - The number.
 */
function writeOctal (header: Buffer, offset: number, length: number, value: number): void {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii')
}

/**
 * Builds a ustar header block.
 *
 * @param name - The path, cut to 100 bytes.
 * @param size - The size of the body, 0 when a PAX record gives it.
 * @param mtime - The last change.
 * @param type - The entry type.
 * @returns The header block.
 */
function headerOf (name: string, size: number, mtime: Date, type: string): Buffer {
  const header = Buffer.alloc(BLOCK)
  header.write(name, 0, USTAR_NAME_BYTES, 'utf-8')
  writeOctal(header, 100, 8, 0o644)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, size)
  writeOctal(header, 136, 12, Math.floor(mtime.getTime() / 1000))
  header.write(type, 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  header.write(`${checksumOf(header).toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

/**
 * Builds a PAX record, its length counting itself.
 *
 * @param key - The key.
 * @param value - The value.
 * @returns The record.
 */
function paxRecord (key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  let length = Buffer.byteLength(body) + 1
  while (String(length).length + Buffer.byteLength(body) !== length) {
    length = String(length).length + Buffer.byteLength(body)
  }
  return `${length}${body}`
}

/**
 * Writes a tar archive of files, each path behind `./` as the tar command writes those of a folder,
 * PAX records carrying the paths longer than 100 bytes and the sizes too large for ustar.
 *
 * @param entries - The files; each body must hold exactly `size` bytes.
 * @returns The uncompressed archive.
 */
export async function* writeTar (entries: AsyncIterable<TarEntry>): AsyncGenerator<Buffer> {
  for await (const { name: relative, size, mtime = new Date(), body } of entries) {
    const name = `./${relative}`
    const records = [
      ...(Buffer.byteLength(name) > USTAR_NAME_BYTES ? [paxRecord('path', name)] : []),
      ...(size >= MAX_OCTAL_SIZE ? [paxRecord('size', String(size))] : [])
    ]
    if (records.length > 0) {
      const data = Buffer.from(records.join(''))
      yield headerOf('PaxHeader', data.length, mtime, 'x')
      yield Buffer.concat([data, Buffer.alloc(paddingOf(data.length))])
    }

    yield headerOf(name, size < MAX_OCTAL_SIZE ? size : 0, mtime, '0')
    let written = 0
    for await (const chunk of body) {
      written += chunk.length
      yield chunk
    }
    if (written !== size) {
      throw new Error(`${relative} holds ${written} bytes instead of ${size}`)
    }
    yield Buffer.alloc(paddingOf(size))
  }
  yield Buffer.alloc(BLOCK * 2)
}
