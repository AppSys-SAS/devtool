---
name: devtool-mcp-setup
description: Connects a coding agent to the MCP server of the devtool (a local development environment running terminals, commands, scripts, a load balancer and files) and configures what agents may do in it with adt.mcp. Use when the devtool tools are missing, when a devtool call is refused, or when the user asks to allow, restrict or review what agents can do in the devtool.
---

# Devtool MCP server: connection and permissions

The devtool server (`devtool server`) exposes an MCP server over Streamable HTTP at
`http://127.0.0.1:<adt.ports.server>/mcp` (port 6730 by default). It only answers this machine; requests
relayed by its load balancer or sent by web pages of other hosts are refused.

## Connect an agent

1. The server must be enabled in the devtool configuration (`config.yml` or `config.local.yml` of the
   configuration folder, `~/.config/appsys/devtool` by default):

   ```yaml
   adt:
     mcp:
       enabled: true
   ```

   The devtool reloads its configuration from the reload button of its sidebar; nothing else restarts.
2. Declare the server to the agent:
   - Claude Code: `claude mcp add --transport http devtool http://127.0.0.1:6730/mcp`
   - Agents configured by JSON (Cursor, Gemini CLI and others): an HTTP / Streamable HTTP server named
     `devtool` with the URL `http://127.0.0.1:6730/mcp`.
   - Agents speaking stdio only: a bridge such as `npx mcp-remote http://127.0.0.1:6730/mcp`.
3. The first tool call of a new agent opens a request in the devtool interface ("New client"): the user
   accepts it for the session or always. The interface must be open in a browser, otherwise the call is
   refused with "no devtool interface is open".

The Agents page of the interface (robot icon next to the bookmark icon of the sidebar) shows the
command above, the sessions, the history of every call, the grants and the effective permissions.

## How calls are decided

1. The client: `adt.mcp.clients` (`deny` patterns, then clients accepted always, then `allow` patterns,
   then `level`, `ask` by default).
2. The rule of what the call acts on, one level per action:
   - `read`: see a command, a terminal, a file
   - `run`: start a command, a script, a section, a restore, a sync
   - `input`: type into a terminal
   - `control`: stop, restart, close, resize a terminal, free a port, reload the configuration
   - `write`: change files
3. Levels: `allow` (no question), `ask` (a request in the interface, with a browser notification when
   `adt.mcp.notifications` is on), `keys` (files only: keys of YAML / JSON / .env files without their
   values), `deny` (refused, and hidden from listings when it is `read`).
4. A grant given from a request or from the history ("This session", "Always") turns `ask` into `allow`
   for that call; a `deny` of the configuration always prevails.

## Configuration reference

`mcp` takes the same form everywhere, from the most general to the most precise, the most precise one
declared winning action by action: `adt.mcp.default`, then a section, a project, a folder of scripts, a
command or a script; `adt.mcp.default`, then a section, a project and a folder of files;
`adt.mcp.default`, then `environment.mcp`; `adt.mcp.default`, then `loadBalancers.<name>.mcp`.

```yaml
adt:
  mcp:
    enabled: true
    notifications: true
    timeout: 120                 # seconds before a request without answer is refused
    default: { read: allow, run: ask, input: ask, control: ask, write: ask }
    clients: { level: ask, allow: [ claude-code ], deny: [] }
    ownTerminals: allow          # typing into and controlling the terminals an agent started itself
    shell:                       # run_shell, command lines outside the configuration
      level: ask                 # deny when absent
      allow: [ "git status*", "pnpm test*" ]
      deny: [ "rm *" ]
sections:
  front:
    mcp: allow                   # short form: every action
projects:
  web:
    section: front
    mcp: { input: deny }         # object form: only the actions named
    commands:
      dev: { name: Dev server, args: [ pnpm, dev ], mcp: { run: allow, control: allow } }
    scripts:
      - path: scripts
        mcp: { run: ask }
        scripts:
          deploy.sh: { mcp: deny }
    files:
      settings: { path: config, mcp: { read: keys, write: keys } }
environment:
  mcp: { read: keys, run: ask }
```

Agents never write the configuration of the devtool itself (`devtool/config.yml` and its `.local.yml`).

## When a call is refused

The error says why: the user denied it, nobody answered in time, no interface is open, or a setting
refuses it (its name is given, such as `projects.web.files.settings allows the keys of the file only`).
Do not retry the same call unchanged: use another mode (`keys`), ask the user to change the setting
named, or to open the devtool interface.
