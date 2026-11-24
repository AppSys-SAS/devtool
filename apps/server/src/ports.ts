import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stripAnsi, type PortConflict, type PortOwner } from '@appsys/devtool-shared'

const execFileAsync = promisify(execFile)

const PORT_IN_USE_WITH_PORT = [
  /EADDRINUSE[^\n]*?:(\d{2,5})\b/,
  /:(\d{2,5}): bind: address already in use/i,
  /address already in use[^\n]*?:(\d{2,5})\b/i,
  /\bport (\d{2,5}) is (?:already )?in use/i,
  /Bind for \S*?:(\d{2,5}) failed: port is already allocated/i,
  /\balready running (?:at|on) \S*?:(\d{2,5})\b/i
]
const PORT_IN_USE = /EADDRINUSE|address already in use|port is already allocated/i
const KILL_TIMEOUT_MS = 5_000
const KILL_POLL_MS = 200
const MAX_WATCHED_OUTPUT = 4096

/**
 * Tells whether output reports a port already in use, and which one.
 * @param text The output, without terminal escape sequences.
 * @returns The port, null when the output does not name it, undefined when it reports no such error.
 */
export function findPortInUse (text: string): number | null | undefined {
  for (const pattern of PORT_IN_USE_WITH_PORT) {
    const match = pattern.exec(text)
    if (match) {
      return Number(match[1])
    }
  }
  return PORT_IN_USE.test(text) ? null : undefined
}

/**
 * Lists the processes listening on a TCP port, the current process excepted.
 * @param port The port.
 * @returns The processes, with their command line.
 */
export async function listPortOwners (port: number): Promise<PortOwner[]> {
  let pids: number[]
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'])
    pids = [...new Set(stdout.split('\n').map(Number).filter(pid => pid > 0 && pid !== process.pid))]
  } catch {
    return []
  }
  if (!pids.length) {
    return []
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'pid=,command=', '-p', pids.join(',')])
    return stdout
      .split('\n')
      .map(line => /^\s*(\d+)\s+(.*)$/.exec(line))
      .filter(match => match !== null)
      .map(match => ({ pid: Number(match[1]), command: match[2] }))
  } catch {
    return pids.map(pid => ({ pid, command: '' }))
  }
}

/**
 * Tells whether a process is still alive.
 * @param pid The process.
 * @returns True while it runs.
 */
function isAlive (pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Stops processes: SIGTERM, then SIGKILL for those still alive after a few seconds. The current
 * process is never stopped.
 * @param owners The processes.
 * @returns Why each process that could not be stopped was not.
 */
export async function killPortOwners (owners: PortOwner[]): Promise<string[]> {
  const errors: string[] = []
  const pending = owners.filter(owner => owner.pid !== process.pid)
  for (const owner of pending) {
    try {
      process.kill(owner.pid, 'SIGTERM')
    } catch (error) {
      errors.push(`pid ${owner.pid}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const deadline = Date.now() + KILL_TIMEOUT_MS
  while (Date.now() < deadline && pending.some(owner => isAlive(owner.pid))) {
    await new Promise(resolve => {
      setTimeout(resolve, KILL_POLL_MS)
    })
  }
  for (const owner of pending.filter(candidate => isAlive(candidate.pid))) {
    try {
      process.kill(owner.pid, 'SIGKILL')
    } catch (error) {
      errors.push(`pid ${owner.pid}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return errors
}

/**
 * Follows the output of a run of a command and finds, once, the port it could not use and the
 * processes holding it.
 */
export class PortConflictWatcher {
  private _output = ''

  private _reported = false

  /**
   * @param _fallbackPorts The ports the command is expected to use, checked when its error names none.
   */
  constructor (private readonly _fallbackPorts: number[]) {}

  /**
   * Takes output of the command.
   * @param data The output.
   * @returns The conflict the first time complete lines report one whose port is held, null otherwise.
   */
  async feed (data: string): Promise<PortConflict | null> {
    if (this._reported) {
      return null
    }

    this._output = `${this._output}${stripAnsi(data)}`.slice(-MAX_WATCHED_OUTPUT)
    const port = findPortInUse(this._output.slice(0, this._output.lastIndexOf('\n') + 1))
    if (port === undefined) {
      return null
    }

    this._reported = true
    for (const candidate of port === null ? this._fallbackPorts : [port]) {
      const owners = await listPortOwners(candidate)
      if (owners.length) {
        return { port: candidate, owners }
      }
    }
    return null
  }
}
