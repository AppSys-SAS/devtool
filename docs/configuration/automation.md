---
description: Skip commands that are not needed, answer their questions, and read secrets from 1Password, files or other commands.
---

:::: v-pre

# Automation and secrets

Some commands need a little help to run on their own: a login that is only needed once a day, a
password prompt, a token that must never be written in the configuration. This page shows the three
tools the devtool gives you for that: `unless`, `answers` and **value blocks**.

They work on the commands of your projects, and also on the renewal of
[certificates](/configuration/certificates) and the [coding agents](/agents/coding-agents) of pull requests
and issues.

## A command that logs in only when needed

```yaml [config.yml]
projects:
  cloud:
    commands:
      login:
        name: Cloud login
        opAccount: my-team.1password.com
        unless: [ my-cli, status ]
        args: [ my-cli, login, --user, "{{ op://Engineering/Cloud/username }}" ]
        env:
          TOKEN: "{{ $(security find-generic-password -w -s my-token) }}"
          API_KEY: "{{ file://.env#/API_KEY }}"
        answers:
          - { match: "Enter password", value: "{{ op://Engineering/Cloud/password }}" }
          - { match: OTP, value: "{{ op://Engineering/Cloud/otp?attribute=otp }}" }
```

When you click **Cloud login**:

1. `my-cli status` runs first. If it succeeds, you are already logged in and the command is skipped.
2. Otherwise the value blocks of `args` and `env` are read: the user name from 1Password, the token from
   the macOS keychain, the API key from the project's `.env`.
3. `my-cli login` starts. When it prints `Enter password`, the devtool types the password from
   1Password; when it asks for an `OTP`, it types the current one-time code.

::: tip There is no root `login:` key
Older examples showed this block at the root of the configuration. It is the body of a command: put it
under `projects.<project>.commands.<slug>`, as above.
:::

## `unless`: skip a command

`unless` is a command line run first, in the same shell and folder as the command. If it exits with
success, the command does not run. Use it for anything idempotent: a login, an install, a container
already started.

```yaml [config.yml]
projects:
  web:
    commands:
      install:
        name: Install
        unless: [ test, -d, node_modules ]
        args: [ pnpm, install ]
```

`%{ADT:CWD}` stands for the folder of the command, in `unless` as in `args`.

## `answers`: reply to questions

`answers` is a list of `{ match, value }`. While the command runs, the devtool watches its output. When
the text printed since the previous answer matches `match`, it types `value` followed by Enter.

- `match` is a regular expression, case-insensitive: `password` matches `Password:`.
- Each answer is used once, in the order of the list.
- `value` may hold value blocks; they are read when the question shows up, not before.

## Value blocks: read secrets at the last moment

A value block is `{{ ... }}` inside a text of the configuration. The devtool replaces it with what it
reads, right before the command starts. Nothing is ever written to disk or to the configuration.

### `{{ op://vault/item/field }}`: 1Password

Reads a field of 1Password with `op read`. `opAccount` picks the account: its ID, or its sign-in
address, which is the same for the whole team (`my-team.1password.com`).

The references are read in a terminal of their own, opened for one run of the command and closed when
it ends. 1Password asks you to authorize each run, and never reuses an earlier authorization.

On macOS, the devtool runs under an application named after
[`adt.displayName`](/configuration/devtool), so the 1Password prompt names your devtool rather than
`node`. That name also covers the commands that call `op` themselves.

### `{{ file://path#/pointer }}`: a value from a file

Reads one value of a YAML (`.yml`, `.yaml`), JSON (`.json`) or environment file (`.env`, `.env.*`,
`*.env`). The part after `#` is a JSON pointer:

| Block | Reads |
| --- | --- |
| `{{ file://.env#/API_KEY }}` | `API_KEY` of the `.env` of the project |
| `{{ file://config.yml#/database/password }}` | `password` under `database` |
| `{{ file://hosts.json#/hosts/0/token }}` | `token` of the first item of `hosts` |
| `{{ file://~/.config/glab-cli/config.yml#/hosts/gitlab.example.dev/token }}` | a key holding dots |
| `{{ file://secrets/key.pem }}` | the whole file, any kind |

- The path is relative to the folder of the command, and accepts `~/`.
- In a key, write `~1` for a `/` and `~0` for a `~`.
- Without `#`, the whole file is read, trailing newlines removed.
- A missing file, a missing key, or a key holding a map or a list stops the command before it starts.

### `{{ $(command) }}`: the output of a command

Runs a command in the folder of the command and uses its standard output, trailing newlines removed. A
command of a project runs it in its own shell, as a login shell; an integration token or a certificate
renewal runs it with `/bin/sh`. A failure stops the command before it starts.

```yaml [config.yml]
projects:
  web:
    integrations:
      pulls: { name: Pull requests, type: pullRequests, token: "{{ $(gh auth token) }}" }
```

### `{{ auth://value }}`: who is signed in

Reads a value of the developer signed in with the [identity provider](/configuration/auth):
`{{ auth://token }}` (the access token), `{{ auth://username }}`, `{{ auth://name }}`,
`{{ auth://email }}` and `{{ auth://groups }}` (separated by commas). If nobody is signed in, the command
stops before it starts. The [Sign-in](/configuration/auth#values-of-the-signed-in-developer) page has
examples.

### Where and when blocks are read

| Where | When |
| --- | --- |
| `args` and `env` of a command | when the command starts |
| `value` of an answer | when its question shows up |
| `token` of a pull request or issue integration | once per run of the server |
| `command`, `lego` options and `env` of a certificate renewal | when the renewal starts |
| `args` and `env` of an agent | when the agent starts |

Every value read is **masked** in the output of the command, so a token printed by mistake never shows
in the terminal.

::: warning What never reads value blocks
- Scripts of a [scripts folder](/configuration/commands#scripts).
- `detached` commands.
- Text typed in an input, and the text of a pull request or an issue.
- Anything outside the configuration.

Only the configuration can read secrets.
:::

::: warning `$VAR` is expanded when the configuration loads
`$VAR` and `${VAR}` in any text of the configuration are replaced by the devtool's own environment when
the file is read, not when the command runs. `sh -c "echo $HOME"` gets your home folder at load time.
`{{ $(...) }}` is not affected.
:::

## Reference

### Automation keys

These keys go in a command, an agent of `adt.agents`, an integration or the `acme` of a certificate.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `unless` | list of words | | A check run first; its success skips the command. |
| `answers` | list of `{ match, value }` | | Texts typed when the output matches. |
| `answers[].match` | string | required | Case-insensitive regular expression. |
| `answers[].value` | string | required | Text typed, value blocks read. |
| `opAccount` | string | | 1Password account: ID or sign-in address. |

### Value blocks

| Block | Reads |
| --- | --- |
| `{{ op://<vault>/<item>/<field> }}` | A 1Password field, with `opAccount`. |
| `{{ file://<path>#<pointer> }}` | A value of a YAML, JSON or `.env` file, or a whole file. |
| `{{ $(<command>) }}` | The output of a command in the login shell. |
| `{{ auth://<value> }}` | `token`, `username`, `name`, `email` or `groups` of the signed-in developer. |

### Warnings

- `unless: must be an array of strings or numbers`.
- `answers: must be { match, value }`.
- `answers[i].match: is not a valid regular expression`.
- `unknown value block {{...}}, expected {{ op://… }}, {{ file://… }}, {{ $(…) }} or {{ auth://… }}`:
  shown when the configuration is read, for a block no source reads (`{{ auth://password }}` too).

::::
