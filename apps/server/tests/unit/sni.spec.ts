import net from 'node:net'
import type { AddressInfo } from 'node:net'
import tls from 'node:tls'
import { describe, expect, it } from 'vitest'
import { readServerName } from '../../src/sni.js'

interface HelloOptions {
  sessionId?: Buffer
  cipherSuites?: Buffer
  compression?: Buffer
  extensions?: Buffer[]
}

/**
 * Prefixes bytes with their length, written big endian.
 * @param bytes - Number of bytes of the length prefix.
 * @param body - Bytes to prefix.
 * @returns The length prefix followed by the body.
 */
function lengthPrefixed (bytes: number, body: Buffer): Buffer {
  const header = Buffer.alloc(bytes)
  header.writeUIntBE(body.length, 0, bytes)
  return Buffer.concat([header, body])
}

/**
 * Builds a TLS extension.
 * @param type - Extension type.
 * @param data - Extension data.
 * @returns The extension with its type and length.
 */
function extension (type: number, data: Buffer): Buffer {
  const header = Buffer.alloc(2)
  header.writeUInt16BE(type)
  return Buffer.concat([header, lengthPrefixed(2, data)])
}

/**
 * Builds a server name extension holding a single name.
 * @param name - Server name, written one byte per character.
 * @param nameType - Type of the name entry.
 * @returns The server name extension.
 */
function serverNameExtension (name: string, nameType = 0): Buffer {
  const entry = Buffer.concat([Buffer.from([nameType]), lengthPrefixed(2, Buffer.from(name, 'latin1'))])
  return extension(0x0000, lengthPrefixed(2, entry))
}

/**
 * Builds the body of a ClientHello handshake message.
 * @param options - Fields of the hello, defaults used for the missing ones.
 * @returns The ClientHello body.
 */
function clientHelloBody (options: HelloOptions = {}): Buffer {
  return Buffer.concat([
    Buffer.from([0x03, 0x03]),
    Buffer.alloc(32, 0xab),
    lengthPrefixed(1, options.sessionId ?? Buffer.alloc(32, 0x01)),
    lengthPrefixed(2, options.cipherSuites ?? Buffer.from([0x13, 0x01, 0x13, 0x02])),
    lengthPrefixed(1, options.compression ?? Buffer.from([0x00])),
    lengthPrefixed(2, Buffer.concat(options.extensions ?? []))
  ])
}

/**
 * Wraps a body in a handshake message.
 * @param body - Handshake message body.
 * @param type - Handshake message type.
 * @returns The handshake message with its type and length.
 */
function handshake (body: Buffer, type = 0x01): Buffer {
  return Buffer.concat([Buffer.from([type]), lengthPrefixed(3, body)])
}

/**
 * Splits bytes into consecutive TLS records.
 * @param message - Bytes carried by the records.
 * @param fragmentSize - Maximum number of bytes per record.
 * @param type - Record content type.
 * @returns The records, concatenated.
 */
function records (message: Buffer, fragmentSize = message.length, type = 0x16): Buffer {
  const parts: Buffer[] = []
  for (let offset = 0; offset < message.length; offset += fragmentSize) {
    parts.push(Buffer.concat([Buffer.from([type, 0x03, 0x01]), lengthPrefixed(2, message.subarray(offset, offset + fragmentSize))]))
  }
  return Buffer.concat(parts)
}

/**
 * Builds a ClientHello in a single handshake record.
 * @param options - Fields of the hello.
 * @returns The record bytes.
 */
function clientHello (options: HelloOptions = {}): Buffer {
  return records(handshake(clientHelloBody(options)))
}

/**
 * Extracts the handshake bytes carried by a sequence of TLS records.
 * @param data - Concatenated records.
 * @returns The record payloads, concatenated.
 */
function payloadOf (data: Buffer): Buffer {
  const parts: Buffer[] = []
  for (let offset = 0; offset + 5 <= data.length; offset += 5 + data.readUInt16BE(offset + 3)) {
    parts.push(data.subarray(offset + 5, offset + 5 + data.readUInt16BE(offset + 3)))
  }
  return Buffer.concat(parts)
}

/**
 * Captures the first bytes a Node TLS client sends to a local TCP server.
 * @param options - TLS connection options of the client.
 * @returns The first chunk received by the server.
 */
async function captureClientHello (options: tls.ConnectionOptions): Promise<Buffer> {
  const server = net.createServer()
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  let client: tls.TLSSocket | undefined
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      server.once('connection', socket => {
        socket.once('data', (chunk: Buffer) => {
          resolve(chunk)
          socket.destroy()
        })
      })
      client = tls.connect({ host: '127.0.0.1', port, ...options })
      client.on('error', reject)
    })
  } finally {
    client?.destroy()
    await new Promise(resolve => {
      server.close(resolve)
    })
  }
}

describe('readServerName', () => {
  it('waits for more bytes when nothing was received', () => {
    expect(readServerName(Buffer.alloc(0))).toBeUndefined()
  })

  it('gives null for bytes that are not a TLS handshake', () => {
    expect(readServerName(Buffer.from('GET / HTTP/1.1\r\n'))).toBeNull()
  })

  it('gives null as soon as the first byte is not a handshake record', () => {
    expect(readServerName(Buffer.from([0x47]))).toBeNull()
    expect(readServerName(Buffer.from([0x17, 0x03, 0x03]))).toBeNull()
  })

  it('reads the name of a ClientHello in a single record', () => {
    expect(readServerName(clientHello({ extensions: [serverNameExtension('app.example.dev')] }))).toBe('app.example.dev')
  })

  it('gives the name in lower case', () => {
    expect(readServerName(clientHello({ extensions: [serverNameExtension('API.Example.DEV')] }))).toBe('api.example.dev')
  })

  it('ignores bytes following the ClientHello', () => {
    const data = Buffer.concat([
      clientHello({ extensions: [serverNameExtension('app.example.dev')] }),
      records(Buffer.from('ignored'), 7, 0x17)
    ])
    expect(readServerName(data)).toBe('app.example.dev')
  })

  it('reads a handshake length shorter than its record', () => {
    const body = clientHelloBody({ extensions: [serverNameExtension('app.example.dev')] })
    expect(readServerName(records(Buffer.concat([handshake(body), Buffer.alloc(10)])))).toBe('app.example.dev')
  })

  it.each([1, 2, 3, 4, 5, 7, 50, 100])('reads a ClientHello split into records of %i bytes', size => {
    const message = handshake(clientHelloBody({ extensions: [serverNameExtension('app.example.dev')] }))
    expect(readServerName(records(message, size))).toBe('app.example.dev')
  })

  it('waits for more bytes at every truncation of a single record', () => {
    const data = clientHello({ extensions: [serverNameExtension('app.example.dev')] })
    for (let length = 0; length < data.length; length++) {
      expect(readServerName(data.subarray(0, length)), `${length} bytes`).toBeUndefined()
    }
  })

  it('waits for more bytes at every truncation of a split ClientHello', () => {
    const data = records(handshake(clientHelloBody({ extensions: [serverNameExtension('app.example.dev')] })), 3)
    for (let length = 0; length < data.length; length++) {
      expect(readServerName(data.subarray(0, length)), `${length} bytes`).toBeUndefined()
    }
  })

  it('waits while the handshake header is incomplete', () => {
    expect(readServerName(records(Buffer.from([0x01, 0x00, 0x01])))).toBeUndefined()
  })

  it('gives null for a non handshake record type', () => {
    expect(readServerName(records(handshake(clientHelloBody({ extensions: [serverNameExtension('app.example.dev')] })), undefined, 0x17))).toBeNull()
  })

  it('gives null when a later record is not a handshake record', () => {
    const message = handshake(clientHelloBody({ extensions: [serverNameExtension('app.example.dev')] }))
    const data = Buffer.concat([records(message.subarray(0, 20)), records(message.subarray(20), undefined, 0x15)])
    expect(readServerName(data)).toBeNull()
  })

  it('gives null for a handshake message that is not a ClientHello', () => {
    expect(readServerName(records(handshake(clientHelloBody({ extensions: [serverNameExtension('app.example.dev')] }), 0x02)))).toBeNull()
  })

  it('gives null as soon as the handshake header names another message type', () => {
    expect(readServerName(records(Buffer.from([0x02, 0x00, 0x10, 0x00])))).toBeNull()
  })

  it('gives null for a ClientHello without extensions', () => {
    expect(readServerName(clientHello())).toBeNull()
  })

  it('gives null for a ClientHello without a server name extension', () => {
    const extensions = [extension(0x002b, Buffer.from([0x02, 0x03, 0x04])), extension(0x0010, Buffer.from([0x00, 0x03, 0x02, 0x68, 0x32]))]
    expect(readServerName(clientHello({ extensions }))).toBeNull()
  })

  it('gives null for a ClientHello whose body stops after the compression methods', () => {
    const body = Buffer.concat([Buffer.from([0x03, 0x03]), Buffer.alloc(32), lengthPrefixed(1, Buffer.alloc(0)), lengthPrefixed(2, Buffer.from([0x13, 0x01])), lengthPrefixed(1, Buffer.from([0x00]))])
    expect(readServerName(records(handshake(body)))).toBeNull()
  })

  it.each([1, 0xff])('gives null for a server name of type %i', nameType => {
    expect(readServerName(clientHello({ extensions: [serverNameExtension('app.example.dev', nameType)] }))).toBeNull()
  })

  it('gives null for an empty host name', () => {
    expect(readServerName(clientHello({ extensions: [serverNameExtension('')] }))).toBeNull()
  })

  it.each([
    ['a non ASCII byte', 'caf\xe9.example.dev'],
    ['a byte with the high bit set', 'app\xff.example.dev'],
    ['a space', 'app .example.dev'],
    ['a null byte', 'app\x00.example.dev'],
    ['a control character', 'app\x1f.example.dev'],
    ['a delete character', 'app\x7f.example.dev']
  ])('gives null for a host name holding %s', (_label, name) => {
    expect(readServerName(clientHello({ extensions: [serverNameExtension(name)] }))).toBeNull()
  })

  it('reads a host name holding the first and last visible ASCII characters', () => {
    expect(readServerName(clientHello({ extensions: [serverNameExtension('!app~')] }))).toBe('!app~')
  })

  it('finds the server name after other extensions', () => {
    const extensions = [
      extension(0x000a, Buffer.from([0x00, 0x04, 0x00, 0x1d, 0x00, 0x17])),
      extension(0x0017, Buffer.alloc(0)),
      extension(0x002b, Buffer.from([0x02, 0x03, 0x04])),
      extension(0x0015, Buffer.alloc(200)),
      serverNameExtension('app.example.dev'),
      extension(0x0010, Buffer.from([0x00, 0x03, 0x02, 0x68, 0x32]))
    ]
    expect(readServerName(clientHello({ extensions }))).toBe('app.example.dev')
  })

  it.each([
    ['an empty session id', { sessionId: Buffer.alloc(0) }],
    ['a 32 byte session id', { sessionId: Buffer.alloc(32, 0x07) }],
    ['a single cipher suite', { cipherSuites: Buffer.from([0x13, 0x01]) }],
    ['many cipher suites', { cipherSuites: Buffer.alloc(200, 0xc0) }],
    ['several compression methods', { compression: Buffer.from([0x01, 0x00]) }],
    ['no compression method', { compression: Buffer.alloc(0) }]
  ])('reads the name of a ClientHello with %s', (_label, options: HelloOptions) => {
    expect(readServerName(clientHello({ ...options, extensions: [serverNameExtension('app.example.dev')] }))).toBe('app.example.dev')
  })

  it('reads a name of the maximum length a single record holds', () => {
    const name = `${'a'.repeat(16000)}.example.dev`
    expect(readServerName(clientHello({ extensions: [serverNameExtension(name)] }))).toBe(name)
  })

  it('reads a ClientHello larger than a single record', () => {
    const name = `${'a'.repeat(20000)}.example.dev`
    expect(readServerName(records(handshake(clientHelloBody({ extensions: [serverNameExtension(name)] })), 16384))).toBe(name)
  })

  describe('malformed lengths', () => {
    it('gives null for a ClientHello shorter than its version and random', () => {
      expect(readServerName(records(handshake(Buffer.alloc(20))))).toBeNull()
    })

    it('gives null when the session id length overflows the ClientHello', () => {
      const body = Buffer.concat([Buffer.from([0x03, 0x03]), Buffer.alloc(32), Buffer.from([0x20, 0x00])])
      expect(readServerName(records(handshake(body)))).toBeNull()
    })

    it('gives null when the cipher suites length overflows the ClientHello', () => {
      const body = Buffer.concat([Buffer.from([0x03, 0x03]), Buffer.alloc(32), Buffer.from([0x00, 0x00, 0x40, 0x13, 0x01])])
      expect(readServerName(records(handshake(body)))).toBeNull()
    })

    it('gives null when the compression length overflows the ClientHello', () => {
      const body = Buffer.concat([Buffer.from([0x03, 0x03]), Buffer.alloc(32), Buffer.from([0x00, 0x00, 0x02, 0x13, 0x01, 0x05, 0x00])])
      expect(readServerName(records(handshake(body)))).toBeNull()
    })

    it('gives null when the ClientHello stops inside the extensions length', () => {
      const body = Buffer.concat([Buffer.from([0x03, 0x03]), Buffer.alloc(32), Buffer.from([0x00, 0x00, 0x02, 0x13, 0x01, 0x01, 0x00, 0x00])])
      expect(readServerName(records(handshake(body)))).toBeNull()
    })

    it('reads the name when the extensions length overstates the extensions', () => {
      const body = clientHelloBody({ extensions: [serverNameExtension('app.example.dev')] })
      const extensionsLengthOffset = body.length - serverNameExtension('app.example.dev').length - 2
      body.writeUInt16BE(0xffff, extensionsLengthOffset)
      expect(readServerName(records(handshake(body)))).toBe('app.example.dev')
    })

    it('gives null when an extension length overflows the extensions', () => {
      const truncated = serverNameExtension('app.example.dev')
      truncated.writeUInt16BE(truncated.length, 2)
      expect(readServerName(clientHello({ extensions: [truncated] }))).toBeNull()
    })

    it('gives null when an extension before the server name overflows the extensions', () => {
      const overflowing = extension(0x0010, Buffer.alloc(4))
      overflowing.writeUInt16BE(0x1000, 2)
      expect(readServerName(clientHello({ extensions: [overflowing, serverNameExtension('app.example.dev')] }))).toBeNull()
    })

    it('gives null when the server name extension is too short to hold a name', () => {
      expect(readServerName(clientHello({ extensions: [extension(0x0000, Buffer.from([0x00, 0x01, 0x00]))] }))).toBeNull()
    })

    it('gives null for an empty server name extension', () => {
      expect(readServerName(clientHello({ extensions: [extension(0x0000, Buffer.alloc(0))] }))).toBeNull()
    })

    it('gives null when the name length overflows the server name extension', () => {
      const sni = serverNameExtension('app.example.dev')
      sni.writeUInt16BE(0x0100, 7)
      expect(readServerName(clientHello({ extensions: [sni, extension(0x0015, Buffer.alloc(0x0200))] }))).toBeNull()
    })

    it('waits for more bytes when the handshake length exceeds the bytes received', () => {
      const message = handshake(clientHelloBody({ extensions: [serverNameExtension('app.example.dev')] }))
      message.writeUIntBE(message.length, 1, 3)
      expect(readServerName(records(message))).toBeUndefined()
    })
  })

  describe('with a ClientHello sent by Node', () => {
    it('reads the server name of the connection', async () => {
      const data = await captureClientHello({ servername: 'app.example.dev' })
      expect(readServerName(data)).toBe('app.example.dev')
    })

    it('reads the server name once split into small records', async () => {
      const data = await captureClientHello({ servername: 'app.example.dev' })
      expect(readServerName(records(payloadOf(data), 64))).toBe('app.example.dev')
    })

    it('waits for more bytes at every truncation', async () => {
      const data = await captureClientHello({ servername: 'app.example.dev' })
      for (let length = 0; length < data.length; length++) {
        expect(readServerName(data.subarray(0, length)), `${length} bytes`).toBeUndefined()
      }
    })

    it('gives null when the connection targets an IP address without a server name', async () => {
      expect(readServerName(await captureClientHello({}))).toBeNull()
    })

    it.each(['TLSv1.2', 'TLSv1.3'] as const)('reads the server name of a %s ClientHello', async version => {
      const data = await captureClientHello({ servername: 'app.example.dev', minVersion: version, maxVersion: version })
      expect(readServerName(data)).toBe('app.example.dev')
    })
  })
})
