import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * Reads the 1Password references written to its terminal, one per line, answering each with
 * `@@<exit code> <base64 value or error>@@`. Takes the 1Password account as optional argument.
 */

const [account] = process.argv.slice(2)
const accountArgs = account ? ['--account', account] : []

/**
 * Reads a reference with the terminal as input of `op`.
 * @param {string} reference The reference.
 * @returns {Promise<{ code: number, output: string }>} The exit code of `op`, and the value or the error.
 */
function read (reference) {
  return new Promise(resolve => {
    const child = spawn('op', ['read', '--no-newline', ...accountArgs, reference], { stdio: ['inherit', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk.toString()))
    child.stderr.on('data', chunk => (stderr += chunk.toString()))
    child.on('error', error => resolve({ code: 127, output: error.message }))
    child.on('close', code => resolve(code === 0 ? { code: 0, output: stdout } : { code: code ?? 1, output: stderr.trim() }))
  })
}

process.stdin.setRawMode(true)
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const reference = line.trim()
  if (reference) {
    const { code, output } = await read(reference)
    process.stdout.write(`@@${code} ${Buffer.from(output).toString('base64')}@@\n`)
  }
}
