import dgram from 'node:dgram'
import packet, { type DecodedPacket } from 'dns-packet'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DevtoolDns } from '../../src/dns.js'

let upstream: dgram.Socket
let upstreamPort: number
const dns = new DevtoolDns()

/**
 * Builds an A query.
 * @param name The name asked.
 * @returns The encoded query.
 */
function query (name: string): Buffer {
  return packet.encode({ id: 7, type: 'query', flags: packet.RECURSION_DESIRED, questions: [{ name, type: 'A' }] })
}

/**
 * Gives the addresses of an answer.
 * @param answer The encoded answer.
 * @returns Its A records.
 */
function addressesOf (answer: Buffer | null): unknown[] {
  const decoded: DecodedPacket = packet.decode(answer!)
  return (decoded.answers ?? []).map(record => record.type === 'A' ? record.data : null)
}

beforeEach(async () => {
  upstream = dgram.createSocket('udp4')
  upstream.on('message', (message, client) => {
    const asked = packet.decode(message)
    const answer = packet.encode({ id: asked.id, type: 'response', questions: asked.questions, answers: [{ name: asked.questions![0].name, type: 'A', ttl: 60, data: '10.0.0.9' }] })
    upstream.send(answer, client.port, client.address)
  })
  await new Promise<void>(resolve => {
    upstream.bind(0, '127.0.0.1', () => resolve())
  })
  upstreamPort = upstream.address().port
})

afterEach(async () => {
  await dns.apply(null)
  upstream.close()
})

describe('DevtoolDns', () => {
  it('answers its own names and relays the other ones to its upstream server', async () => {
    await dns.apply({ port: 0, access: 'local', records: [{ names: ['app.example.dev'], address: '192.168.1.20' }], upstream: { host: '127.0.0.1', port: upstreamPort } })

    expect(addressesOf(await dns.answer(query('app.example.dev')))).toEqual(['192.168.1.20'])
    expect(addressesOf(await dns.answer(query('other.example.dev')))).toEqual(['10.0.0.9'])
  })
})
