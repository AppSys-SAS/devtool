import type { Socket } from "node:net";
import type { HostAccess } from "@appsys/devtool-shared";

/**
 * Tells whether a connection comes from this machine.
 * @param address The remote address of the connection.
 * @returns True for a loopback address, IPv4 or IPv6.
 */
export function isLoopback(address: string | undefined): boolean {
  if (!address) {
    return false;
  }

  const ipv4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return ipv4.startsWith("127.") || address === "::1";
}

const clientAddresses = new WeakMap<Socket, string>();

/**
 * Remembers the address of the client of a connection that cannot tell it, such as a TLS socket opened
 * over a stream.
 * @param socket The connection.
 * @param address The remote address of the client.
 */
export function rememberClientAddress(socket: Socket, address: string | undefined): void {
  if (address) {
    clientAddresses.set(socket, address);
  }
}

/**
 * Gives the address of the client of a connection.
 * @param socket The connection.
 * @returns The remote address, undefined when unknown.
 */
export function clientAddressOf(socket: Socket): string | undefined {
  return clientAddresses.get(socket) ?? socket.remoteAddress;
}

/**
 * Tells whether a client may reach a host.
 * @param access Who reaches the host.
 * @param address The remote address of the client connection, never a forwarded header.
 * @returns True when the client is allowed.
 */
export function allows(access: HostAccess, address: string | undefined): boolean {
  return access === "network" || isLoopback(address);
}

/**
 * Tells whether a host name matches a pattern.
 * @param pattern An exact host name, or `*.<domain>` for its subdomains.
 * @param host The host name, lower case.
 * @returns True when the host matches.
 */
export function matchesHost(pattern: string, host: string): boolean {
  return pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern;
}
