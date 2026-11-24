---
description: Decide what coding agents may see and do in the devtool, from the whole devtool down to one command.
---

# Agent permissions (MCP)

The devtool can serve coding agents through its [MCP server](/agents/mcp-server): they read terminals,
start commands, edit files. `adt.mcp` turns it on and decides what each agent may do, so you can let an
agent restart your dev server freely while it must ask before deploying, and never sees your secrets.

```yaml [config.yml]
adt:
  mcp:
    enabled: true
    default: { read: allow, run: ask, input: ask, control: ask, write: ask }
    commands: { run: allow }
```

With this, agents read everything, start the commands of the configuration on their own, and ask you
for anything else.

## Actions and levels

Every call of an agent is one of five actions:

| Action | What it covers |
|---|---|
| `read` | see: list commands, read terminals and files |
| `run` | start a command, a script, a restore, a shell command |
| `input` | type into a terminal |
| `control` | stop, restart, resize a terminal, free a port, reload the configuration |
| `write` | change files |

Each action gets a level:

| Level | Meaning |
|---|---|
| `allow` | done at once |
| `ask` | a dialog in the interface asks you; refused after `timeout` seconds, or at once when no interface is open |
| `deny` | refused; `read: deny` even hides the item from the agent |
| `keys` | files only, for `read` and `write`: the agent sees the keys and the type of each value, never the values, and writes with `update_keys` |

You give one level for every action, or levels by action:

```yaml [config.yml]
projects:
  web:
    mcp: { input: deny }
    commands:
      dev: { name: Dev server, args: [ pnpm, dev ], mcp: { run: allow, control: allow } }
      deploy: { name: Deploy, args: [ ./deploy.sh ], mcp: deny }
```

## From general to precise

A setting inherits from the more general ones and wins over them. `adt.mcp.default` is the base of
everything:

- **commands and restores:** `adt.mcp.default` > `adt.mcp.commands` > section > project > command
- **scripts:** `adt.mcp.default` > `adt.mcp.scripts` > section > project > folder of scripts > script
- **folders of files:** `adt.mcp.default` > `adt.mcp.files` > section > project > folder of files
- **terminals you opened without a command:** `adt.mcp.default` > `adt.mcp.terminals` (the terminal of a
  command follows its command)
- **certificates:** `adt.mcp.default` > `adt.mcp.certificates` > `loadBalancers.<name>.mcp`
- **`port_owners` (read) and `reload_config` (control):** `adt.mcp.default` > `adt.mcp.devtool`
- **the files of Configs and the `environment_*` tools:** `adt.mcp.default` > `environment.mcp` > the `mcp`
  of each item of `environment.files`, `databases`, `buckets` and `redis` (a `.local.yml` override follows
  its file; a pull or push of several items takes the strictest of them)

A setting of a section or a project wins over the categories (`adt.mcp.commands`...), being more precise.

```yaml [config.yml]
adt:
  mcp:
    enabled: true
    files: { read: keys }
environment:
  mcp: { read: keys, run: ask }
  files:
    - devtool/config.yml
    - { path: api/api.env, mcp: { write: deny } }
projects:
  web:
    files:
      settings: { path: config, mcp: { read: keys, write: keys } }
    scripts:
      - { path: scripts, mcp: { run: ask }, scripts: { deploy.sh: { mcp: deny } } }
```

::: tip Short form in lists
An item of a list written as a text, such as `- devtool/config.yml`, is the short form of
`{ path: devtool/config.yml }`. Your `config.local.yml` can give it settings at the same position, such
as an `mcp` level.
:::

## Agents and shell commands

- `clients` decides which agents may connect. An unknown agent waits for you to accept it, unless
  `level` says otherwise. `allow` and `deny` list agent names.
- `shell` decides the command lines `run_shell` may run, outside the commands of the configuration. It is
  denied by default. `allow` and `deny` are patterns where `*` matches any text and the whole line must
  match; `deny` wins over `allow`.
- `ownTerminals` covers typing into and controlling the terminals an agent started itself, `allow` by
  default.

```yaml [config.yml]
adt:
  mcp:
    enabled: true
    clients: { level: ask, allow: [ claude-code ], deny: [] }
    shell: { level: ask, allow: [ "git status*", "pnpm test*" ], deny: [ "rm *" ] }
    ownTerminals: allow
```

## What no setting changes

- `notify_user` is always allowed.
- A push to a backend of the environment and the pull of the shared configuration are always confirmed
  by you.
- Agents never write the devtool configuration.
- A `deny` of the configuration beats any grant you gave from a dialog.

## Grants and the Agents page

When an agent asks, you answer for this session of the agent or always. The Agents page (robot icon next
to the bookmark icon of the sidebar) lists the sessions and clients, the requests waiting, the history of
every call, the grants, and the effective level of every action with the setting it comes from.

Its **Edit** mode changes these levels, or removes one (Inherit). Nothing is written until **Done**, which
writes every change at once, keeping comments and layout, then reloads the configuration:

- **Personal** writes to `config.local.yml`, loaded last, so it wins over every file and include;
- **Shared** writes to the file declaring each setting (`config.yml` or an included file).

## Reference

### adt.mcp

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Serve MCP clients of this machine. |
| `notifications` | boolean | `adt.notifications` | Notify when an agent asks for permission. |
| `timeout` | integer | `120` | Seconds before an unanswered request is refused. |
| `ownTerminals` | `allow`, `ask` | `allow` | Terminals an agent started itself. |
| `default` | rules | `{ read: allow, run: ask, input: ask, control: ask, write: ask }` | Base of every other setting. |
| `commands` | rules | `default` | Commands and restores. |
| `scripts` | rules | `default` | Scripts. |
| `files` | rules | `default` | Folders of files; `keys` allowed. |
| `terminals` | rules | `default` | Terminals opened without a command. |
| `certificates` | rules | `default` | Certificates. |
| `devtool` | rules | `default` | `port_owners` and `reload_config`. |
| `clients` | `{ level, allow, deny }` | `{ level: ask }` | Agents that may connect. |
| `shell` | `{ level, allow, deny }` | `{ level: deny }` | Command lines of `run_shell`. |

### mcp elsewhere

Rules (a level, or levels by action) are accepted on:

| Key | Inherits from |
|---|---|
| `sections.<slug>.mcp` | `adt.mcp.default` |
| `projects.<slug>.mcp` | its section |
| `projects.<slug>.commands.<slug>.mcp` | `adt.mcp.commands`, section, project |
| `projects.<slug>.scripts[].mcp`, `...scripts[].scripts.<file>.mcp` | `adt.mcp.scripts`, section, project |
| `projects.<slug>.files.<slug>.mcp` | `adt.mcp.files`, section, project; `keys` allowed |
| `loadBalancers.<name>.mcp` | `adt.mcp.certificates` |
| `environment.mcp` | `adt.mcp.default`; `keys` allowed |
| `environment.files[].mcp` | `environment.mcp`; `keys` allowed |
| `environment.databases[].mcp`, `buckets[].mcp`, `redis[].mcp` | `environment.mcp` |

### Files kept in the cache

The history (last 1000 calls), the grants and the clients accepted always are kept in `adt.cacheDir`:
`mcp-history.jsonl`, `mcp-grants.json` and `mcp-clients.json`.

### Warnings

- `must be one of allow, keys, ask, deny, or levels by action (read, run, input, control, write)`
- `<action> is not an action (read, run, input, control, write)`
- `keys is for the settings of files only`
- `adt.mcp.timeout: must be a positive number of seconds`
- `adt.mcp.ownTerminals: must be allow or ask`
- `adt.mcp.shell.level: must be allow, ask or deny` (`keys` is refused there)
- `adt.mcp.shell.allow: must be an array of patterns`
