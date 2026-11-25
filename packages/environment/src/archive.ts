import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline, Readable, type Transform, type Writable } from 'node:stream'
import { pipeline as pipelineAsync } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'

/** Header of an archive record: its kind and the attributes needed to restore it. */
export type RecordHeader = Record<string, unknown>

/** A record read from an archive; its body must be read before the next record is. */
export interface ArchiveRecord {
  header: RecordHeader
  body: AsyncIterable<Buffer>
}

const MAX_FRAME_BYTES = 64 * 1024
const END_OF_BODY = Buffer.from('0\n')

/**
 * Writes a chunk, waiting for the stream to drain when its buffer is full.
 *
 * @param stream - The destination.
 * @param chunk - The bytes.
 */
async function write (stream: Writable, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) {
    await once(stream, 'drain')
  }
}

/**
 * Writes an archive file: a gzip stream of records, each a JSON header line followed by its body in
 * length-prefixed frames, so bodies of unknown length are streamed without being held in memory.
 */
export class ArchiveWriter {
  private readonly _gzip = createGzip()
  private readonly _finished: Promise<void>

  /**
   * @param filePath - The archive file to create, readable by the current user only.
   */
  constructor (filePath: string) {
    this._finished = pipelineAsync(this._gzip, createWriteStream(filePath, { mode: 0o600 }))
    this._finished.catch(() => undefined)
  }

  /**
   * Appends a record.
   *
   * @param header - The header of the record.
   * @param body - The body of the record.
   */
  async add (header: RecordHeader, body: AsyncIterable<Buffer> | Iterable<Buffer> = []): Promise<void> {
    await write(this._gzip, Buffer.from(`${JSON.stringify(header)}\n`))
    for await (const chunk of body) {
      for (let offset = 0; offset < chunk.length; offset += MAX_FRAME_BYTES) {
        const frame = chunk.subarray(offset, offset + MAX_FRAME_BYTES)
        await write(this._gzip, Buffer.from(`${frame.length}\n`))
        await write(this._gzip, frame)
      }
    }
    await write(this._gzip, END_OF_BODY)
  }

  /**
   * Ends the archive and waits for it to be written.
   */
  async close (): Promise<void> {
    this._gzip.end()
    await this._finished
  }

  /**
   * Abandons the archive.
   */
  abort (): void {
    this._gzip.destroy()
  }
}

/**
 * Passes a stream through a transform, an error of either side failing the result.
 *
 * @param source - The stream.
 * @param transform - The transform, such as a compression.
 * @returns The transformed stream.
 */
export function transformed (source: AsyncIterable<Buffer>, transform: Transform): Readable {
  return pipeline(Readable.from(source), transform, () => undefined)
}

/**
 * Reads lines and exact byte counts from a stream of chunks.
 */
class BufferedReader {
  private _buffer: Buffer = Buffer.alloc(0)

  /**
   * @param _source - The chunks to read.
   */
  constructor (private readonly _source: AsyncIterator<Buffer>) {}

  /**
   * Reads up to the next line feed.
   *
   * @returns The line without its line feed, or null at the end of the stream.
   */
  async readLine (): Promise<string | null> {
    for (;;) {
      const end = this._buffer.indexOf(10)
      if (end >= 0) {
        const line = this._buffer.toString('utf-8', 0, end)
        this._buffer = this._buffer.subarray(end + 1)
        return line
      }

      if (!(await this.fill())) {
        if (this._buffer.length > 0) {
          throw new Error('truncated archive')
        }
        return null
      }
    }
  }

  /**
   * Reads an exact number of bytes.
   *
   * @param size - The number of bytes.
   * @returns The bytes.
   */
  async read (size: number): Promise<Buffer> {
    while (this._buffer.length < size) {
      if (!(await this.fill())) {
        throw new Error('truncated archive')
      }
    }

    const chunk = this._buffer.subarray(0, size)
    this._buffer = this._buffer.subarray(size)
    return chunk
  }

  /**
   * Appends the next chunk of the source to the buffer.
   *
   * @returns False at the end of the source.
   */
  private async fill (): Promise<boolean> {
    const chunk = await this._source.next()
    if (chunk.done) {
      return false
    }
    const value = chunk.value

    this._buffer = this._buffer.length > 0 ? Buffer.concat([this._buffer, value]) : value
    return true
  }
}

/**
 * Builds the body of the record being read, which still reads the frames left when its reader
 * stops early, so the next record can be found.
 *
 * @param reader - The archive reader, positioned on the first frame of the body.
 * @returns The body and a function skipping what remains of it.
 */
function bodyOf (reader: BufferedReader): { body: AsyncIterable<Buffer>, skip: () => Promise<void> } {
  let ended = false
  const next = async (): Promise<IteratorResult<Buffer>> => {
    if (ended) {
      return { done: true, value: undefined }
    }

    const size = Number(await reader.readLine())
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error('corrupted archive')
    }

    if (size === 0) {
      ended = true
      return { done: true, value: undefined }
    }

    return { done: false, value: await reader.read(size) }
  }
  const iterator: AsyncIterator<Buffer> = { next, return: () => Promise.resolve({ done: true, value: undefined }) }

  return {
    body: { [Symbol.asyncIterator]: () => iterator },
    skip: async () => {
      while (!(await next()).done);
    }
  }
}

/**
 * Reads the records of an archive file, one at a time.
 *
 * @param filePath - The archive file.
 * @returns The records, in their order in the archive.
 */
export async function* readArchive (filePath: string): AsyncGenerator<ArchiveRecord> {
  const source: Readable = pipeline(createReadStream(filePath), createGunzip(), () => undefined)
  const reader = new BufferedReader(source[Symbol.asyncIterator]() as AsyncIterator<Buffer>)
  try {
    for (;;) {
      const line = await reader.readLine()
      if (line === null) {
        return
      }

      const { body, skip } = bodyOf(reader)
      yield { header: JSON.parse(line) as RecordHeader, body }
      await skip()
    }
  } finally {
    source.destroy()
  }
}
