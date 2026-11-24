---
description: Connect Claude Code, Codex, Cursor and other coding agents to the devtool through its MCP server.
---

# MCP server

Coding agents work better when they can run your project. The devtool serves them over MCP (Model
Context Protocol): an agent lists your commands, starts the dev server, waits until it is ready, reads
its logs, edits configuration files and checks the environment, all through the same terminals you see
in the interface. You keep control: every action follows the [permissions](/configuration/mcp) you set,
and the interface asks you when an action needs your approval.

## Turn it on

```yaml [config.yml]
adt:
  mcp:
    enabled: true
```

The server then answers MCP clients of this machine over Streamable HTTP at
`http://127.0.0.1:<adt.ports.server>/mcp` (`http://127.0.0.1:6730/mcp` by default). It is never reachable
through the load balancer, nor from web pages of other hosts.

## Connect an agent

Claude Code connects with one command, the server name being `adt.name` (`appsys-devtool` by default):

```bash
claude mcp add --scope user --transport http appsys-devtool http://127.0.0.1:6730/mcp
```

For the other agents (Claude Desktop, Codex, Gemini CLI, opencode, Cursor, GitHub Copilot, Windsurf, Zed,
Cline, Qwen Code, Mistral Vibe, Junie, JetBrains AI Assistant, Warp), the **Connection** tab of the Agents
page gives the exact configuration, and so does the
[setup skill](https://github.com/AppSys-SAS/devtool/blob/main/packages/skills/skills/devtool-mcp-setup/SKILL.md#agent-configurations).
Install the [agent skills](/agents/skills) next to it so the agent knows how to use the tools well.

The agents that the buttons of pull requests and issues start, the [coding agents](/agents/coding-agents),
use the MCP server too once connected: a review or a fix can then run your tests and read your logs.

The first time an agent connects, the devtool asks you whether to accept it, unless
`adt.mcp.clients` already allows or denies it.

## Tools

| Purpose | Tools |
|---|---|
| Discover | `list_projects`: sections and projects. `list_commands`: commands and scripts with their inputs and levels. `list_terminals`: running and ended terminals. |
| Terminals | `read_terminal`: output from a cursor, or the screen. `wait_for_output`: wait for a pattern or the end. `search_terminals`: find an error across terminals. `send_input`: type text and keys. `control_terminal`: start again, stop, restart, close. `resize_terminal`: change its size. |
| Commands | `run_command`: start a command or script of the configuration. `run_shell`: run a command line allowed by `adt.mcp.shell`. `start_section` / `stop_section`: like the buttons of a section. `restore_folder`: run the restore of a missing folder. `resolve_port_conflict`: free a port a command needs. |
| Files | `list_files`, `read_file`, `write_file`: folders of files of the projects and files of the environment. `update_keys`: change keys of YAML, JSON and .env files without seeing their values. `change_files`: create, remove or rename a file or folder. |
| Environment | `environment_status`: state of each item. `environment_keys`: keys that differ from the copy of the backend. `environment_tables`: tables of a database. `environment_sync`: pull or push. `pull_shared_config`: pull the shared devtool configuration. |
| Certificates | `list_certificates`: certificates and their expiry. `renew_certificate`: renew one. |
| Forges | `list_pull_requests`, `list_issues`: items of the [integrations](/configuration/integrations). |
| Devtool | `port_owners`: which processes hold ports. `reload_config`: reload the configuration. `notify_user`: show you a notification. |

The terminals are also resources an agent may subscribe to, to be told when they change:
`devtool://terminals` and `devtool://terminal/<slug>`.

## Sessions

Each agent works in a session. A session closes 30 seconds after its agent lost its event stream (the
agent stopped), or after 30 minutes without request for an agent that keeps none; the agent then starts a
new one. A call the agent abandons, or whose session closes, withdraws its request, shown as `Cancelled`
in the history.

## The Agents page

Open it with the robot icon next to the bookmark icon of the sidebar. It shows:

- the connection instructions for each agent;
- the sessions and the accepted clients;
- the requests waiting for you, with their details (a diff for a file change);
- the history of every call, from which you can allow a call again for the session or always;
- the grants, removed one by one or all;
- the effective level of every action, with the setting it comes from, and an Edit mode to change them.

The history (last 1000 calls), the grants and the clients accepted always are kept in `adt.cacheDir`, in
`mcp-history.jsonl`, `mcp-grants.json` and `mcp-clients.json`.

::: tip Notifications
With `adt.mcp.notifications` (on when `adt.notifications` is), a request that needs your answer also shows
a system notification, so you see it even when the devtool tab is in the background.
:::
