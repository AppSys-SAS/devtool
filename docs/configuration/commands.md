---
description: Declare the commands of a project, ask for values when they start, and turn a folder of scripts into commands.
---

# Commands and scripts

Commands are the buttons of a project: start a dev server, run the tests, open a database shell. You
write the command line once in the configuration, and everyone on the team gets the same button, with
the same arguments and the same environment.

When a project already keeps its tasks as shell scripts, you do not have to copy them: point the devtool
at the folder and every executable file becomes a command.

## A first command

```yaml [config.yml]
projects:
  web:
    commands:
      dev: { name: Dev server, args: [ pnpm, dev ] }
      test: { name: Tests, args: [ pnpm, test ] }
```

`dev` and `test` are the slugs of the commands. `args` is the command line, split into words: the first
word is the program, the others its arguments. Each command opens in a terminal of the devtool, in the
folder of the project.

To make `dev` the command the project runs by default (its status shows on the project row, with a
stop and restart button), name it in [`default`](/configuration/projects):

```yaml [config.yml]
projects:
  web:
    default: { action: command:dev }
    commands:
      dev: { name: Dev server, args: [ pnpm, dev ], startWithSection: true }
```

`startWithSection: true` also starts it when you start the whole [section](/configuration/sections)
from its header.

::: warning `default` is not a command slug
A command named `default` is refused, with the warning
`is replaced by default: { action: command:<slug> }`. Pick another slug and name it in the project's
`default` instead.
:::

## Ask for values when the command starts

An item of `args` can be an **input** instead of a fixed word. When you click the command, the devtool
asks for it and puts what you chose in its place.

There are three kinds of inputs:

- **Choices**: one value out of a list, shown as buttons (the default) or a dropdown.
- **Flag**: a checkbox; when ticked, the input's `name` is added to the command line.
- **Text**: free text, split into words like a shell would.

```yaml [config.yml]
projects:
  e2e:
    commands:
      run:
        name: End-to-end tests
        args:
          - yarn
          - test:e2e
          - name: project
            choices: [ admin, { label: Shared files, value: shared-files } ]
            default: admin
            display: dropdown
          - { name: --headed, flag: true }
          - { name: extra arguments, text: true, default: --retries 1 }
```

Clicking **End-to-end tests** asks for a project (Admin filled in), offers a `--headed` checkbox and a
text field. Picking Shared files and ticking the box runs
`yarn test:e2e shared-files --headed --retries 1`.

A choice is either a plain value, or `{ label, value }` when the text you want to show differs from the
value passed to the command.

### When the inputs are asked

- From the project page, a command asks in a **dialog** by default. With `form: inline`, its row unfolds
  with the fields and its description instead.
- From the sidebar, the devtool always asks in a dialog.
- Every field starts with its `default` value.
- When a command starts **on its own** (as the `default` of its project, or with its section), it runs
  with the default values and asks nothing. It still asks when a required choice has no default.

::: tip Value blocks are never read in what you type
Text typed in an input is passed as is. A 1Password reference typed by hand is not read as a
[value block](/configuration/automation): only the configuration can read secrets.
:::

## Environment, shell and stop signal

```yaml [config.yml]
adt:
  shell: /bin/zsh
projects:
  api:
    commands:
      dev:
        name: API
        args: [ pnpm, dev ]
        env: { PORT: "3000", LOG_LEVEL: debug }
        killSignal: SIGINT
      worker:
        name: Worker
        args: [ pnpm, worker ]
        env:
          - { QUEUE: emails }
          - { LOG_LEVEL: info }
```

- `env` is a map of variables, or a list of maps merged in order, added on top of the
  [`env` of the project](/configuration/projects#environment-shell-and-stop-signal): a variable both
  declare takes the value of the command. Values are text: quote numbers.
- `shell` is the shell the command runs in: the command's own, else its project's, else
  [`adt.shell`](/configuration/devtool), else `$SHELL`.
- `killSignal` is the signal sent when you stop the command, `SIGTERM` by default. Some servers only
  shut down cleanly on `SIGINT`.

Every command also receives `APPSYS_DEVTOOL=true` and `APPSYS_DEVTOOL_CACHE_DIR` (the
[cache folder](/configuration/devtool)), so a script can tell it runs inside the devtool.

::: warning A non-text value drops the whole `env`
If one value of `env` is not a string (`PORT: 3000` without quotes), the devtool ignores the whole map
without a warning. Quote every value.
:::

`%{ADT:CWD}` in `args` stands for the folder the command runs in.

## Commands that ask questions, and background commands

- `prompt: true` runs the command in the background instead of a terminal tab. When it asks a question
  on its terminal, the question shows in a dialog. Use it for short tasks you do not want to watch.
- `detached: true` starts the command outside of any terminal and forgets it: no output, no status.
  Use it to open an application.

::: warning Detached commands read no secrets
A `detached` command never reads [value blocks](/configuration/automation) and never runs its `unless`
check.
:::

## Scripts

`scripts` turns folders of executable files into commands. A folder is listed again as soon as a file is
added or removed, so a new script shows up without reloading anything.

```yaml [config.yml]
projects:
  api:
    scripts:
      - scripts
      - path: tools
        only: [ "*.sh" ]
        form: dialog
        scripts:
          deploy.sh: { prompt: true, args: [ { name: env, choices: [ staging, production ] } ] }
```

- A text item (`- scripts`) is the short form of `{ path: scripts }`.
- `path` is relative to the project. Only executable files are kept; hidden files are left out.
- `only` keeps the file names matching one of its glob patterns.
- The slug of a script is its path from the project, such as `tools/deploy.sh`.
- `scripts` gives settings to one file, by file name: `prompt`, `args`, `form` and `mcp`.

### Describe a script in its header

The comment at the top of a script (the `#` lines right after the shebang) becomes its description:
its first paragraph is the summary, and a `Usage:` line, with the indented lines after it, shows how to
call it.

```sh [tools/deploy.sh]
#!/bin/sh
# Deploys the API to an environment.
#
# Usage: deploy.sh <env>
#   env  staging or production
```

### What scripts do differently

- A script without `args` asks for one free text input, `arguments`, passed after its path.
- Scripts show their fields **inline** by default (`form: inline`), commands in a dialog.
- Scripts get the `env`, `shell` and `killSignal` of their project.
- Scripts never read [value blocks](/configuration/automation): put secrets in a command instead.
- A command with the same slug as a script hides the script, with a warning.

## Reference

### `projects.<project>.commands.<slug>`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | string | the slug | Label of the button. |
| `args` | list | required | The command line. Each item is a word, a number or an input. An empty list opens the shell. |
| `env` | map or list of maps | `{}` | Environment variables. Value blocks are read. |
| `shell` | string | the project's | Shell running the command. |
| `killSignal` | string | `SIGTERM` | Signal sent to stop the command (`SIG` and letters or digits). |
| `detached` | boolean | `false` | Start outside of any terminal, without output. |
| `prompt` | boolean | `false` | Run in the background, its questions in a dialog. |
| `startWithSection` | boolean | `false` | Start with the section, from its header. |
| `form` | `dialog` or `inline` | `dialog` | Where the project page asks for the inputs. |
| `notifications` | boolean | the project's | Notify when the command ends. |
| `opAccount`, `unless`, `answers` | | | See [Automation and secrets](/configuration/automation). |
| `mcp` | level or levels | inherited | What agents may do with it, see [Agent permissions](/configuration/mcp). |
| `meta.icon` | string | `ph:terminal` | Iconify name of its icon. |

### Inputs

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | string | required | Label of the field; the word added by a flag. |
| `choices` | list | | Values to pick from: a value or `{ label, value }`. |
| `display` | `buttons` or `dropdown` | `buttons` | How the choices show. |
| `optional` | boolean | `false` | A choice may be left empty. |
| `flag` | `true` | | A checkbox adding `name` when ticked. |
| `text` | `true` | | Free text, split like a shell does. |
| `default` | value, boolean or text | | Value filled in: one of the choices, a boolean for a flag, a text. |

When `choices` is not empty, the input is a choice even if it also says `flag` or `text`.

### `projects.<project>.scripts[]`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | string | required | Folder of executables, relative to the project. |
| `prompt` | boolean | `false` | Run its scripts in the background, questions in a dialog. |
| `form` | `dialog` or `inline` | `inline` | Where the project page asks for the inputs. |
| `only` | list of globs | all files | File names to keep. |
| `scripts.<file>` | map | | `prompt`, `args`, `form` and `mcp` of one file. |
| `mcp` | level or levels | inherited | What agents may do with its scripts. |

### Warnings

- `args: must be an array of strings, numbers or inputs`: the command is dropped.
- `is replaced by default: { action: command:<slug> }`: a command is named `default`.
- `form: must be dialog or inline`.
- `killSignal: must match SIG* format (example: SIGTERM, SIGKILL)`.
- `must be a string, a number, or an input with choices, flag: true or text: true`: an item of `args`.
- `display: must be buttons or dropdown`, `must be a value or { label, value }` (a choice).
- `default: must be one of the choices`, `must be a boolean` or `must be a string`.
- `only: must be an array of glob patterns`.
- `<slug> is hidden by the command of the same slug`: a script and a command share a slug.
