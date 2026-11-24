---
description: Agent skills shipped with the devtool, and how to install them in Claude Code, Codex, Gemini CLI or Cursor.
---

# Agent skills

The [MCP server](/agents/mcp-server) gives an agent tools; skills teach it when and how to use them:
wait for a dev server before testing, read only the new output of a terminal, never ask for a secret
value. The repository ships three skills in its
[`packages/skills`](https://github.com/AppSys-SAS/devtool/tree/main/packages/skills/skills) folder. They follow the open Agent
Skills format (a folder per skill holding a `SKILL.md`), so the same folders work in Claude Code, Codex
CLI, Gemini CLI, Cursor and the other agents that read it.

| Skill | Use it to |
|---|---|
| `devtool-mcp-setup` | connect an agent to the devtool, and configure what agents may do (`adt.mcp`) |
| `devtool-terminals` | run commands and scripts, follow and drive terminals, debug a failing service, free a port |
| `devtool-files-environment` | read and change project files, configuration keys without their secret values, the shared environment and certificates |

## Install them

The skills ship with the devtool. Put them where your agents load skills with:

```bash
devtool skills sync
```

The command asks which folders to fill, among those the agents read, and how to put the skills there:

| Agent | One project | Every project |
|---|---|---|
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| Codex CLI, Gemini CLI, Cursor, Amp and other agents of the format | `.agents/skills/` | `~/.agents/skills/` |

- **Copy**, the default: the skills stay in place if the devtool is reinstalled or moved. Run the command
  again after updating the devtool.
- **Link**: the skills follow the installation of the devtool and are always up to date, but break if it
  is reinstalled somewhere else (another Node.js version, another package manager).

Run it again whenever you like: it updates the skills it installed, removes those the devtool no longer
ships, and leaves your own skills alone. A skill of your own with the same name as one of the devtool is
kept unless you agree to replace it. Two folders linked to each other (`~/.claude/skills` pointing to
`~/.agents/skills`, for instance) get the skills once.

In a script, or without a terminal, give the folders and the mode:

```bash
devtool skills sync --target ~/.agents/skills ~/.claude/skills --link
```

Some agents also read their own folder (`.gemini/skills/`, `.cursor/skills/`): pass it with `--target`
when a skill is not picked up.

::: tip Tool names
The skills name the tools as the server declares them (`list_commands`, `read_terminal`...). Your agent
may show them with a prefix, such as `mcp__appsys-devtool__list_commands` in Claude Code.
:::

## Serve them over MCP

Instead of copying folders, the [MCP server](/agents/mcp-server) can serve skills to the agents connected
to it, through the Skills extension of MCP (`io.modelcontextprotocol/skills`). Agents that support it
load them from the devtool and always get the current version. The skills of the devtool are served as
soon as the MCP server is on; the skills of your folders only when you ask:

```yaml [config.yml]
adt:
  mcp:
    enabled: true
    skills: true          # the skills of the devtool, the default; false to keep them out
projects:
  agents:
    path: ~/.agents
    files:
      skills:
        name: Skills
        path: skills
        type: agentSkills
        mcpSkills: [ review, "deploy-*" ]   # or true for every skill of the folder
```

- `adt.mcp.skills` serves the skills shipped with the devtool; it is `true` unless you set it to `false`.
- `mcpSkills` on a folder of files of `type: agentSkills` serves its skills: `true` for all of them, or a
  list of globs matching the names of their folders.
- Skills of the devtool are served under `skill://devtool/<skill>/`, those of a folder under
  `skill://files/<project>/<directory>/<files>/<skill>/`. Agents name a skill by the `name` of its
  `SKILL.md`, such as `/appsys-devtool:review` in Claude Code.
- A change to a served folder reaches the agents within a second, without restarting anything.
- Served skills are readable by any agent connected to the MCP server, without asking you: serve only
  what any of your agents may read.

::: info Support in agents
The Skills extension is recent. Claude Code reads skills from MCP servers from version 2.1.331, while the
feature is in beta. An agent without support still uses the tools of the server; install the skills with
`devtool skills sync` for it.
:::

## Edit skills in the devtool

A folder of files with `type: agentSkills` lists the skills it holds, checks their format and edits each
`SKILL.md` as a form. Point one at your own skills folder to keep them next to your projects: see
[Files](/configuration/files).

```yaml [config.yml]
projects:
  agents:
    path: ~/.agents
    files:
      skills: { name: Skills, path: skills, type: agentSkills }
```
