import type { Socket } from 'node:net'
import { type HostAccess, isLoopback } from '@appsys-sas/devtool-shared'

const relayedClients = new Map<number, string>()

/**
 * Remembers the client of a connection relayed from this machine, by the local port of the relay.
 * @param localPort The local port of the relaying connection.
 * @param address The remote address of the client.
 */
export function rememberRelayedClient (localPort: number | undefined, address: string | undefined): void {
  if (localPort !== undefined && address) {
    relayedClients.set(localPort, address)
  }
}

/**
 * Forgets the client of a relayed connection once the relay is closed.
 * @param localPort The local port of the relaying connection.
 */
export function forgetRelayedClient (localPort: number | undefined): void {
  if (localPort !== undefined) {
    relayedClients.delete(localPort)
  }
}

/**
 * Gives the address of the client of a connection, the relayed client for a relay of this machine.
 * @param socket The connection.
 * @returns The remote address, undefined when unknown.
 */
export function clientAddressOf (socket: Pick<Socket, 'remoteAddress' | 'remotePort'>): string | undefined {
  const relayed = socket.remotePort !== undefined && isLoopback(socket.remoteAddress) ? relayedClients.get(socket.remotePort) : undefined
  return relayed ?? socket.remoteAddress
}

/**
 * Tells whether a client may reach a host.
 * @param access Who reaches the host.
 * @param address The remote address of the client connection, never a forwarded header.
 * @returns True when the client is allowed.
 */
export function allows (access: HostAccess, address: string | undefined): boolean {
  return access === 'network' || isLoopback(address)
}

/**
 * Tells whether a host name matches a pattern.
 * @param pattern An exact host name, or `*.<domain>` for its subdomains.
 * @param host The host name, lower case.
 * @returns True when the host matches.
 */
export function matchesHost (pattern: string, host: string): boolean {
  return pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern
}
