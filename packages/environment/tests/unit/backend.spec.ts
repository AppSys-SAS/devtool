import { pipeline, Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { byteCounter, lineReader } from '../../src/backends/backend.js'

describe('byteCounter', () => {
  it('fails a transfer that arrives shorter than announced', async () => {
    const counted = pipeline(Readable.from([Buffer.alloc(10)]), byteCounter(20), () => undefined)
    await expect(counted.toArray()).rejects.toThrow('incomplete transfer: 10 of 20 bytes')
  })
})

describe('lineReader', () => {
  it('tells each line once complete, whatever the pieces it arrives in', () => {
    const lines: string[] = []
    const read = lineReader(line => lines.push(line))
    for (const piece of ['Writing objects:  50% (1/2), 1.00 M', 'iB | 2.00 MiB/s\rWriting objects: 100% (2/2), 2.0', '0 MiB, done.\nTotal 2', '']) {
      read(piece)
    }
    expect(lines).toEqual(['Writing objects:  50% (1/2), 1.00 MiB | 2.00 MiB/s', 'Writing objects: 100% (2/2), 2.00 MiB, done.'])
  })
})
