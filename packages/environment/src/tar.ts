import { Readable } from 'node:stream'
import { extract, type Header, pack, type Pack } from 'tar-stream'

/** A regular file of a tar archive; its body must be read before the next entry is. */
export interface TarEntry {
  /** Its path relative to the archived folder, without the `./` the archive writes before it. */
  name: string
  size: number
  /** Last change, written to the archive; the current date when missing. */
  mtime?: Date
  body: AsyncIterable<Buffer>
}

const REGULAR_TYPES = new Set<Header['type'] | null>(['file', 'contiguous-file'])
const BLOCK_BYTES = 512
const END_BYTES = 2 * BLOCK_BYTES

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
 * Tells why the devtool cannot read an entry of an archive.
 *
 * @param header - The header of the entry.
 * @returns Why the entry is refused, null when it is read or skipped.
 */
function unsupported (header: Header): string | null {
  if (!(header.type as Header['type'] | null)) {
    return 'an entry of an unknown type'
  }
  if (!REGULAR_TYPES.has(header.type) && header.type !== 'directory') {
    return `a ${header.type}`
  }
  const pax = (typeof header.pax === 'object' && header.pax !== null ? header.pax : {}) as Record<string, unknown>
  if (pax.size !== undefined && !(typeof pax.size === 'string' && /^\d+$/.test(pax.size))) {
    return `an entry of an invalid size ${typeof pax.size === 'string' ? pax.size : JSON.stringify(pax.size)}`
  }
  if (!Number.isSafeInteger(header.size) || header.size < 0) {
    return `an entry of an invalid size ${String(header.size)}`
  }
  return Object.keys(pax).some(key => key.startsWith('GNU.sparse.')) ? 'a sparse file' : null
}

/**
 * Gives the offset in an archive just after the padded body of an entry.
 *
 * @param header - The header of the entry, with the offset of its body.
 * @returns The offset.
 */
function entryEnd (header: Header): number {
  const { byteOffset } = header as Header & { byteOffset?: unknown }
  if (typeof byteOffset !== 'number' || !Number.isSafeInteger(byteOffset)) {
    throw new Error('the tar reader gives no offset of the entries')
  }
  const size = header.type === 'directory' ? 0 : header.size
  return byteOffset + Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES
}

/**
 * Reads the regular files of a tar archive, folders being skipped and any other entry refused. The
 * archive must end with its two empty blocks after the body of its last entry: one that stops
 * before is refused once its last entry is read.
 *
 * @param source - The uncompressed archive.
 * @returns The files, in their order in the archive.
 */
export async function* readTar (source: AsyncIterable<Buffer>): AsyncGenerator<TarEntry> {
  let tail: Buffer = Buffer.alloc(0)
  let received = 0
  let lastEnd = 0
  const watched = async function* (): AsyncGenerator<Buffer> {
    for await (const chunk of source) {
      received += chunk.length
      tail = chunk.length >= END_BYTES ? chunk.subarray(-END_BYTES) : Buffer.concat([tail, chunk]).subarray(-END_BYTES)
      yield chunk
    }
  }
  const input = Readable.from(watched())
  const extractor = extract()
  input.on('error', error => extractor.destroy(error))
  input.pipe(extractor)
  try {
    for await (const entry of extractor) {
      const name = relativeName(entry.header.name)
      const refusal = unsupported(entry.header)
      if (refusal !== null) {
        throw new Error(`${name} is ${refusal}, which the devtool does not read`)
      }
      lastEnd = entryEnd(entry.header)
      if (REGULAR_TYPES.has(entry.header.type) && name !== '') {
        yield { name, size: entry.header.size, body: entry as AsyncIterable<Buffer> }
      }
      entry.resume()
    }
    if (received - lastEnd < END_BYTES || tail.some(byte => byte !== 0)) {
      throw new Error('not a complete tar archive: it does not end with its two empty blocks')
    }
  } finally {
    input.destroy()
    extractor.destroy()
  }
}

/**
 * Adds a file to an archive being written, its body closed when the archive fails or closes first.
 *
 * @param packer - The archive.
 * @param entry - The file; its body must hold exactly `size` bytes.
 */
async function addEntry (packer: Pack, { name, size, mtime, body }: TarEntry): Promise<void> {
  const input = Readable.from(body)
  await new Promise<void>((resolve, reject) => {
    const settle = (error?: Error | null): void => {
      packer.off('close', closed)
      if (error) {
        input.destroy()
        reject(error)
      } else {
        resolve()
      }
    }
    const closed = (): void => settle(new Error('the archive was closed while it was written'))
    packer.once('close', closed)
    const sink = packer.entry({ name: `./${name}`, size, mtime }, settle)
    sink.on('error', settle)
    input.on('error', settle)
    input.pipe(sink)
  })
}

/**
 * Writes a tar archive of files, each path behind `./` as the tar command writes those of a folder;
 * nothing is read before the archive is.
 *
 * @param entries - The files; each body must hold exactly `size` bytes.
 * @returns The uncompressed archive.
 */
export async function* writeTar (entries: AsyncIterable<TarEntry>): AsyncGenerator<Buffer> {
  const packer = pack()
  const fill = async (): Promise<void> => {
    for await (const entry of entries) {
      await addEntry(packer, entry)
    }
    packer.finalize()
  }
  fill().catch((error: unknown) => packer.destroy(error instanceof Error ? error : new Error(String(error))))
  try {
    yield* (packer as AsyncIterable<Buffer>)
  } finally {
    packer.destroy()
  }
}
