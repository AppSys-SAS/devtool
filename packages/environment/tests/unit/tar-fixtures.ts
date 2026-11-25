/**
 * Builds a ustar header block.
 * @param name - The path.
 * @param size - The size of the body.
 * @param type - The entry type.
 * @returns The header block.
 */
function rawHeader (name: string, size: number, type: string): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12)
  header.write(type, 156, 1)
  header.write('ustar\u000000', 257, 8)
  let sum = 0
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index]
  }
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return header
}

/**
 * Builds an entry of a tar archive: its header and its body padded to whole blocks.
 * @param name - The path.
 * @param type - The entry type.
 * @param body - The body.
 * @returns The entry bytes.
 */
export function rawEntry (name: string, type: string, body: string): Buffer {
  const bytes = Buffer.from(body)
  return Buffer.concat([rawHeader(name, bytes.length, type), bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)])
}

/**
 * Builds a PAX record, its length counting itself.
 * @param key - The key.
 * @param value - The value.
 * @returns The record.
 */
export function paxRecord (key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  const length = String(body.length + 3).length + body.length
  return `${length}${body}`
}

/** The two empty blocks ending a tar archive. */
export const TAR_END = Buffer.alloc(1024)
