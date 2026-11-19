---
name: devtool-terminals
description: Runs and follows the commands, scripts and terminals of the devtool through its MCP server - start a dev server and wait until it is ready, read logs incrementally, answer interactive prompts, restart a service, free a port, find an error across terminals. Use when working on a project the devtool runs, when a service it runs fails, or when the user asks to run, restart or check one of its commands.
---

# Devtool terminals, commands and scripts

The devtool runs the commands of its configuration in terminals the user also sees in its interface.
Prefer them over starting processes yourself: they bring the environment, answers and secrets of the
configuration, and the user follows what you run.

## Find what to run

- `list_projects`: sections and projects, their folders, the URLs of their services (`https://<host>`)
  and whether the port behind each one listens, file spaces, configuration warnings.
- `list_commands`: commands and scripts with their identifier `<section>/<project>/<slug>` (a script's
  slug is its path, such as `scripts/deploy.sh`), their inputs (choices, flags, text), the terminal
  running them and the level of each action for you.
- `list_terminals`: every terminal, who started it, whether it runs, its exit code and its `cursor`.

## Run

- `run_command { command, inputs?, wait? }`: inputs by name (`{ "env": "staging" }`), defaults
  otherwise. The main command of a project restarts in its own terminal. Example: start a dev server and
  wait until it is ready:

  ```json
  { "command": "front/web/dev", "wait": { "pattern": "ready in|Local:", "timeout": 60 } }
  ```

- `run_shell { command, cwd, wait? }` runs a command line in a new terminal of `<section>` or
  `<section>/<project>`; it is refused unless `adt.mcp.shell` allows it, so prefer `run_command`.
- `start_section` / `stop_section` do what the buttons of a section do.
- `restore_folder` brings back a missing project (a clone, for instance).

`wait: { exit: true }` waits for the end of the process and returns its output and exit code.

## Follow output

- `read_terminal { terminal, since?, lines?, grep? }` returns plain text and a `cursor`; pass that cursor
  as `since` next time to read only what is new instead of the whole log.
- `wait_for_output { terminal, pattern?, exit?, timeout? }` blocks until a regular expression appears
  in new output, or the process ends (300 s at most).
- `search_terminals { pattern }` finds an error in every terminal at once.
- Resources `devtool://terminals` and `devtool://terminal/<slug>` can be subscribed to, when the agent
  supports it, to be told of new output.

The lines the devtool writes itself (`Execute Command: …`, `Process exited …`) are shown but never
matched by `wait_for_output`.

## Interact

- `read_terminal { mode: "screen" }` shows the screen as the user sees it: use it for prompts, menus
  and full-screen programs, where the log is hard to read.
- `send_input { terminal, text?, keys? }` types text then presses keys (`enter`, `tab`, `esc`,
  `backspace`, `up`, `down`, `left`, `right`, `ctrl-c`, `ctrl-d`, `ctrl-z`, `ctrl-l`) and returns the
  screen. Typing into a terminal you started is usually allowed; others may ask the user.
- `control_terminal { action: start | stop | restart | close }`, `resize_terminal`.
- A port already in use shows as `portConflict` on the terminal: `port_owners { port }` tells who holds
  it, `resolve_port_conflict { action: "killAndRestart" }` frees it and restarts the command.

## Good practice

- Check `list_terminals` before starting something that may already run.
- Read incrementally with the cursor; keep `lines` small.
- A call may wait for the user to accept it in the devtool interface; a refusal is final for that call:
  say what you needed and why instead of retrying it.
- Tell the user what you started (`notify_user` shows a message in the interface when the work ends).
