import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const LOGIN_TIMEOUT_MS = 5 * 60_000
const CALLBACK_PAGE = '<!doctype html><meta charset="utf-8"><title>Devtool</title><p>Devtool : connexion terminée, vous pouvez fermer cet onglet.</p>'

/**
 * Opens an address in the default browser of the system.
 * @param url The address.
 */
export function openInBrowser (url: string): void {
  const [command, args]
    = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  spawn(command, args, { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref()
}

/**
 * Waits for the identity provider to redirect the browser to the local callback address.
 * @param port The local port.
 * @param ready Called once the port listens.
 * @returns The callback address with its parameters.
 */
export async function waitForCallback (port: number, ready: () => void | Promise<void>): Promise<URL> {
  return new Promise<URL>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close()
      reject(new Error('sign-in timed out'))
    }, LOGIN_TIMEOUT_MS)
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
      if (url.pathname !== '/callback') {
        response.writeHead(404).end()
        return
      }

      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(CALLBACK_PAGE)
      clearTimeout(timeout)
      server.close()
      resolve(url)
    })
    server.on('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    server.listen(port, '127.0.0.1', () => {
      Promise.resolve(ready()).catch(reject)
    })
  })
}
