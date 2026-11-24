/**
 * Tells whether a connection comes from this machine.
 * @param address The remote address of the connection.
 * @returns True for a loopback address, IPv4 or IPv6.
 */
export function isLoopback (address: string | undefined): boolean {
  if (!address) {
    return false
  }

  const ipv4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return ipv4.startsWith('127.') || address === '::1'
}
