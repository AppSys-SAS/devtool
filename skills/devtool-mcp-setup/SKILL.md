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
2. Declare the server to the agent, as a Streamable HTTP server named `devtool` (replace 6730 by
   `adt.ports.server` when it is changed); see [Agent configurations](#agent-configurations).
3. The first tool call of a new agent opens a request in the devtool interface ("New client"): the user
   accepts it for the session or always. The interface must be open in a browser, otherwise the call is
   refused with "no devtool interface is open". The request shows the name the agent gives: add it to
   `adt.mcp.clients.allow` to accept that agent without asking.

## Agent configurations

Claude Code:

```bash
claude mcp add --transport http devtool http://127.0.0.1:6730/mcp
```

Codex CLI (OpenAI), with `codex mcp add devtool --url http://127.0.0.1:6730/mcp` or in
`~/.codex/config.toml` (`.codex/config.toml` for a trusted project); older releases also need
`experimental_use_rmcp_client = true` at the top of the file:

```toml
[mcp_servers.devtool]
url = "http://127.0.0.1:6730/mcp"
```

opencode, in `opencode.json` of the project or `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "devtool": { "type": "remote", "url": "http://127.0.0.1:6730/mcp", "enabled": true }
  }
}
```

Gemini CLI, in `~/.gemini/settings.json` or `.gemini/settings.json` (`httpUrl`, not `url`, which means
SSE):

```json
{ "mcpServers": { "devtool": { "httpUrl": "http://127.0.0.1:6730/mcp" } } }
```

Cursor, in `~/.cursor/mcp.json` or `.cursor/mcp.json`:

```json
{ "mcpServers": { "devtool": { "url": "http://127.0.0.1:6730/mcp" } } }
```

VS Code (GitHub Copilot), in `.vscode/mcp.json` (`servers` and `type: http`):

```json
{ "servers": { "devtool": { "type": "http", "url": "http://127.0.0.1:6730/mcp" } } }
```

An agent speaking stdio only goes through a bridge, such as `npx mcp-remote http://127.0.0.1:6730/mcp`.
The formats change between releases of the agents: check their documentation when a server does not
show up.

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
declared winning action by action:

- commands and restores: `adt.mcp.default`, `adt.mcp.commands`, section, project, command;
- scripts: `adt.mcp.default`, `adt.mcp.scripts`, section, project, folder of scripts, script;
- folders of files: `adt.mcp.default`, `adt.mcp.files`, section, project, folder of files;
- terminals a person opened without a command: `adt.mcp.default`, `adt.mcp.terminals`;
- certificates: `adt.mcp.default`, `adt.mcp.certificates`, `loadBalancers.<name>.mcp`;
- `port_owners` (read) and `reload_config` (control): `adt.mcp.default`, `adt.mcp.devtool`;
- configuration files and copies of the environment: `adt.mcp.default`, `environment.mcp`.

`notify_user` is always allowed. The Permissions tab of the Agents page shows the level of every action
with the setting it comes from, and its Edit mode changes them in `config.local.yml` (Personal) or in the
file declaring each setting (Shared).

```yaml
adt:
  mcp:
    enabled: true
    notifications: true
    timeout: 120                 # seconds before a request without answer is refused
    default: { read: allow, run: ask, input: ask, control: ask, write: ask }
    commands: { run: allow }     # commands of the configuration
    scripts: { run: ask }        # executables of the folders of scripts
    files: { read: keys }        # folders of files of the projects
    terminals: { input: ask }    # terminals a person opened without a command
    certificates: { run: ask }
    devtool: { control: ask }    # port_owners (read), reload_config (control)
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
