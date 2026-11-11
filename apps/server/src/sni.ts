const TLS_HANDSHAKE_RECORD = 0x16;
const CLIENT_HELLO = 0x01;
const SERVER_NAME_EXTENSION = 0x0000;
const HOST_NAME = 0x00;

/**
 * Reads the server name of a TLS ClientHello.
 * @param hello The body of the ClientHello handshake message.
 * @returns The server name, null when there is none or the message is malformed.
 */
function serverNameOf(hello: Buffer): string | null {
  let offset = 2 + 32;
  const skip = (lengthBytes: 1 | 2): boolean => {
    if (offset + lengthBytes > hello.length) {
      return false;
    }
    offset += lengthBytes + (lengthBytes === 1 ? hello.readUInt8(offset) : hello.readUInt16BE(offset));
    return offset <= hello.length;
  };
  if (!skip(1) || !skip(2) || !skip(1) || offset + 2 > hello.length) {
    return null;
  }

  const extensionsEnd = Math.min(hello.length, offset + 2 + hello.readUInt16BE(offset));
  offset += 2;
  while (offset + 4 <= extensionsEnd) {
    const type = hello.readUInt16BE(offset);
    const length = hello.readUInt16BE(offset + 2);
    const start = offset + 4;
    offset = start + length;
    if (type !== SERVER_NAME_EXTENSION || offset > extensionsEnd || length < 5) {
      continue;
    }
    if (hello.readUInt8(start + 2) !== HOST_NAME) {
      return null;
    }
    const nameLength = hello.readUInt16BE(start + 3);
    return start + 5 + nameLength <= offset ? hello.subarray(start + 5, start + 5 + nameLength).toString("ascii").toLowerCase() : null;
  }
  return null;
}

/**
 * Reads the server name a TLS client asks for, from the first bytes it sent, its ClientHello possibly
 * spread over several records.
 * @param data The bytes received so far.
 * @returns The server name; null when the bytes are not a ClientHello or name no server; undefined
 * while more bytes are needed.
 */
export function readServerName(data: Buffer): string | null | undefined {
  const handshake: Buffer[] = [];
  let offset = 0;
  while (offset + 5 <= data.length) {
    if (data.readUInt8(offset) !== TLS_HANDSHAKE_RECORD) {
      return null;
    }
    const length = data.readUInt16BE(offset + 3);
    if (offset + 5 + length > data.length) {
      return undefined;
    }
    handshake.push(data.subarray(offset + 5, offset + 5 + length));
    offset += 5 + length;

    const message = Buffer.concat(handshake);
    if (message.length >= 4) {
      if (message.readUInt8(0) !== CLIENT_HELLO) {
        return null;
      }
      const helloLength = message.readUIntBE(1, 3);
      if (message.length >= 4 + helloLength) {
        return serverNameOf(message.subarray(4, 4 + helloLength));
      }
    }
  }
  return data.length > 0 && data.readUInt8(0) !== TLS_HANDSHAKE_RECORD ? null : undefined;
}
