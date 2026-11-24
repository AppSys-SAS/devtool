import { computed, shallowRef } from 'vue'
import type { CommandInputValue, DirectoryExtra } from '@appsys/devtool-shared'

/** A command waiting for the values of its inputs. */
export interface CommandInputsRequest {
  /** Tells the request apart from the others. */
  id: number
  command: DirectoryExtra
  /** Runs the command with the values typed. */
  run: (inputs: CommandInputValue[]) => void
}

/**
 * The commands waiting for the values of their inputs, the dialog asking for the first one.
 */
class CommandInputsStore {
  private _requests = shallowRef<CommandInputsRequest[]>([])

  private _nextId = 0

  current = computed(() => this._requests.value[0] ?? null)

  /**
   * Asks for the values of the inputs of a command, after those already asked for, then runs it with them.
   * @param command The command.
   * @param run Runs the command with the values typed.
   */
  ask (command: DirectoryExtra, run: (inputs: CommandInputValue[]) => void): void {
    this._requests.value = [...this._requests.value, { id: this._nextId++, command, run }]
  }

  /**
   * Runs the command asked for with the values typed and asks for the next one.
   * @param inputs The values of its inputs.
   */
  submit (inputs: CommandInputValue[]): void {
    const request = this.current.value
    this.close()
    request?.run(inputs)
  }

  /**
   * Skips the command asked for without running it and asks for the next one.
   */
  close (): void {
    this._requests.value = this._requests.value.slice(1)
  }
}

export default new CommandInputsStore()
