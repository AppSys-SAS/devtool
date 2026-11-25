import { fileURLToPath } from 'node:url'
import { spawn as spawnPty, type IPty } from '@lydell/node-pty'

const TERMINAL_SCRIPT = fileURLToPath(new URL('../bin/op-terminal.mjs', import.meta.url))
const ANSWER = /@@(\d+) ([A-Za-z0-9+/=]*)@@/
const READ_TIMEOUT_MS = 120_000

/**
 * A terminal of its own reading 1Password references: 1Password asks once for the reads of a
 * terminal, and again for every new terminal.
 */
export class OpTerminal {
  private _output = ''

  private _queue: Promise<unknown> = Promise.resolve()

  private _pending: { reference: string, resolve: (value: string) => void, reject: (error: Error) => void } | null = null

  private _closed = false

  /**
   * @param _terminal The terminal running the reading loop.
   */
  private constructor (private readonly _terminal: IPty) {
    _terminal.onData(data => {
      this._output += data
      this.answer()
    })
    _terminal.onExit(() => this.fail(new Error('The 1Password terminal closed')))
  }

  /**
   * Opens a terminal.
   * @param account The 1Password account the references are read from, null for the default one.
   * @returns The terminal.
   */
  static open (account: string | null): OpTerminal {
    return new OpTerminal(spawnPty(process.execPath, [TERMINAL_SCRIPT, ...(account ? [account] : [])], { cols: 200, rows: 24, env: process.env }))
  }

  /**
   * Reads a reference, after the reads asked before it.
   * @param reference The reference, `op://<vault>/<item>/<field>`.
   * @returns Its value.
   */
  read (reference: string): Promise<string> {
    const read = this._queue.then(() => this.readNow(reference))
    this._queue = read.catch(() => undefined)
    return read
  }

  /**
   * Closes the terminal, the next terminal asking 1Password again.
   */
  close (): void {
    if (!this._closed) {
      this._closed = true
      this._terminal.kill()
    }
  }

  /**
   * Asks the terminal for a reference.
   * @param reference The reference.
   * @returns Its value.
   */
  private readNow (reference: string): Promise<string> {
    if (this._closed) {
      return Promise.reject(new Error(`op read ${reference} failed: the 1Password terminal is closed`))
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.fail(new Error(`op read ${reference} timed out`)), READ_TIMEOUT_MS)
      this._pending = {
        reference,
        resolve: value => {
          clearTimeout(timeout)
          resolve(value)
        },
        reject: error => {
          clearTimeout(timeout)
          reject(error)
        }
      }
      this._terminal.write(`${reference}\n`)
    })
  }

  /**
   * Settles the pending read once the terminal answered it.
   */
  private answer (): void {
    const match = ANSWER.exec(this._output)
    const pending = this._pending
    if (!match || !pending) {
      return
    }

    this._output = this._output.slice(match.index + match[0].length)
    this._pending = null
    const output = Buffer.from(match[2], 'base64').toString()
    if (match[1] === '0') {
      pending.resolve(output)
    } else {
      pending.reject(new Error(`op read ${pending.reference} failed${output ? `: ${output.split('\n')[0]}` : ''}`))
    }
  }

  /**
   * Fails the pending read and closes the terminal, whose next answers could not be trusted.
   * @param error Why.
   */
  private fail (error: Error): void {
    const pending = this._pending
    this._pending = null
    this.close()
    pending?.reject(error)
  }
}
