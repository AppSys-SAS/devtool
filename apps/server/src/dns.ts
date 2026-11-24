import dgram from 'node:dgram'
import { lookup } from 'node:dns/promises'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import packet, { type Answer, type DecodedPacket, type Question } from 'dns-packet'
import { logger, type DnsDefinition } from '@appsys/devtool-shared'
import { allows, matchesHost } from './access.js'

/** The DNS listens on every interface, who may query it being decided by its configuration. */
const DNS_LISTEN_ADDRESS = '0.0.0.0'
const RECORD_TTL_SECONDS = 60
const UPSTREAM_TIMEOUT_MS = 3000
const NAME_ERROR = 3
const SERVER_FAILURE = 2

/**
 * Gives the current network address of this machine: the IPv4 address of its first Ethernet or Wi-Fi
 * interface, any other external interface otherwise.
 * @returns The address, null when the machine is offline.
 */
function networkAddress (): string | null {
  const interfaces = Object.entries(os.networkInterfaces()).sort(([a], [b]) => Number(/^en\d+$/.test(b)) - Number(/^en\d+$/.test(a)))
  for (const [, addresses] of interfaces) {
    const address = addresses?.find(candidate => candidate.family === 'IPv4' && !candidate.internal)
    if (address) {
      return address.address
    }
  }
  return null
}

/**
 * Gives the DNS server the system uses, the first of `/etc/resolv.conf` that is not this machine.
 * @returns Its address, null when there is none.
 */
async function upstreamServer (): Promise<string | null> {
  const resolvConf = await fs.readFile('/etc/resolv.conf', 'utf-8').catch(() => '')
  for (const [, server] of resolvConf.matchAll(/^nameserver\s+(\S+)/gm)) {
    if (!server.startsWith('127.') && server !== '::1') {
      return server
    }
  }
  return null
}

/**
 * Sends a query as is to the DNS server of the system.
 * @param query The query.
 * @returns The answer of that server.
 */
async function relay (query: Buffer): Promise<Buffer> {
  const server = await upstreamServer()
  if (!server) {
    throw new Error('no DNS server configured on the system')
  }

  const socket = dgram.createSocket(net.isIPv6(server) ? 'udp6' : 'udp4')
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${server} did not answer`)), UPSTREAM_TIMEOUT_MS)
      socket.once('message', message => {
        clearTimeout(timer)
        resolve(message)
      })
      socket.once('error', reject)
      socket.send(query, 53, server)
    })
  } finally {
    socket.close()
  }
}

/**
 * Builds the answer to a query.
 * @param query The decoded query.
 * @param answers The records answered.
 * @param code The response code, 0 for success.
 * @param authoritative Whether the name is one of this DNS.
 * @returns The encoded answer.
 */
function response (query: DecodedPacket, answers: Answer[], code = 0, authoritative = false): Buffer {
  return packet.encode({
    id: query.id,
    type: 'response',
    flags: packet.RECURSION_DESIRED | packet.RECURSION_AVAILABLE | (authoritative ? packet.AUTHORITATIVE_ANSWER : 0) | code,
    questions: query.questions,
    answers
  })
}

/**
 * A local DNS answering its own names with an address of this machine and resolving every other name
 * through the system, so the devices using it reach the development hosts.
 */
export class DevtoolDns {
  private _config: DnsDefinition | null = null

  private _udp: dgram.Socket | null = null

  private _tcp: net.Server | null = null

  private _port: number | null = null

  /**
   * Takes a configuration, starting, restarting or stopping the servers as needed.
   * @param config The DNS, null to stop it.
   */
  async apply (config: DnsDefinition | null): Promise<void> {
    this._config = config
    if (this._port === (config?.port ?? null)) {
      return
    }

    await this.stop()
    if (config) {
      await this.start(config.port)
    }
  }

  /**
   * Answers a query, from the records when it asks for one of their names, from the system otherwise.
   * @param data The query.
   * @returns The answer, null when the query cannot be read.
   */
  async answer (data: Buffer): Promise<Buffer | null> {
    let query: DecodedPacket
    try {
      query = packet.decode(data)
    } catch {
      return null
    }

    const question: Question | undefined = query.questions?.[0]
    if (!question || !this._config) {
      return null
    }

    const name = question.name.toLowerCase()
    const record = this._config.records.find(candidate => candidate.names.some(pattern => matchesHost(pattern, name)))
    if (record) {
      const address = record.address === 'auto' ? networkAddress() : record.address
      if (!address) {
        return response(query, [], SERVER_FAILURE)
      }
      return response(query, question.type === 'A' ? [{ name: question.name, type: 'A', ttl: RECORD_TTL_SECONDS, data: address }] : [], 0, true)
    }

    try {
      if (question.type === 'A' || question.type === 'AAAA') {
        const results = await lookup(name, { family: question.type === 'A' ? 4 : 6, all: true })
        return response(query, results.map(({ address }) => ({ name: question.name, type: question.type, ttl: RECORD_TTL_SECONDS, data: address }) as Answer))
      }
      return await relay(data)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return response(query, [], code === 'ENOTFOUND' ? NAME_ERROR : code === 'ENODATA' ? 0 : SERVER_FAILURE)
    }
  }

  /**
   * Listens for queries over UDP and TCP.
   * @param port The port.
   */
  private async start (port: number): Promise<void> {
    const udp = dgram.createSocket('udp4')
    udp.on('message', (message, client) => {
      if (!this._config || !allows(this._config.access, client.address)) {
        return
      }
      void this.answer(message).then(answer => answer && udp.send(answer, client.port, client.address))
    })

    const tcp = net.createServer(socket => this.serveTcp(socket))
    try {
      await new Promise<void>((resolve, reject) => {
        udp.once('error', reject)
        udp.bind(port, DNS_LISTEN_ADDRESS, () => resolve())
      })
      await new Promise<void>((resolve, reject) => {
        tcp.once('error', reject)
        tcp.listen(port, DNS_LISTEN_ADDRESS, () => resolve())
      })
    } catch (error) {
      udp.close()
      tcp.close()
      logger.error('DNS', 'Server', `Not started on port ${port}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    udp.on('error', error => logger.warn('DNS', 'UDP', error.message))
    this._udp = udp
    this._tcp = tcp
    this._port = port
    logger.info('DNS', 'Server', `Started on port ${port}`)
  }

  /**
   * Answers the queries of a TCP connection, each prefixed by its length.
   * @param socket The connection.
   */
  private serveTcp (socket: net.Socket): void {
    if (!this._config || !allows(this._config.access, socket.remoteAddress)) {
      socket.destroy()
      return
    }

    let received = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk])
      while (received.length >= 2 && received.length >= 2 + received.readUInt16BE(0)) {
        const query = received.subarray(2, 2 + received.readUInt16BE(0))
        received = received.subarray(2 + query.length)
        void this.answer(query).then(answer => {
          if (answer) {
            const length = Buffer.alloc(2)
            length.writeUInt16BE(answer.length)
            socket.write(Buffer.concat([length, answer]))
          }
        })
      }
    })
    socket.on('error', () => socket.destroy())
  }

  /**
   * Stops listening.
   */
  private async stop (): Promise<void> {
    this._udp?.close()
    await new Promise<void>(resolve => {
      if (this._tcp) {
        this._tcp.close(() => resolve())
      } else {
        resolve()
      }
    })
    this._udp = null
    this._tcp = null
    this._port = null
  }
}
