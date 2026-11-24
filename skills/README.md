# Agent skills for the devtool

Skills teaching coding agents to use the MCP server of the devtool. They follow the open Agent Skills
format (a folder per skill holding a `SKILL.md` with only the standard `name` and `description` fields),
so the same folders work in Claude Code, Codex CLI, Gemini CLI, Cursor and the other agents reading it.

| Skill | Use it to |
|---|---|
| [`devtool-mcp-setup`](devtool-mcp-setup/SKILL.md) | connect an agent to the devtool and configure what agents may do (`adt.mcp`) |
| [`devtool-terminals`](devtool-terminals/SKILL.md) | run commands and scripts, follow and drive terminals, debug a failing service |
| [`devtool-files-environment`](devtool-files-environment/SKILL.md) | read and change the files of the projects, configuration keys and the CDN environment |

## Installation

```bash
devtool skills sync
```

The command asks which skill folders of your agents to fill, and whether to copy the skills or link
them to the installation of the devtool; run it again to update them. Without a terminal, give the
folders and the mode: `devtool skills sync --target ~/.agents/skills ~/.claude/skills --copy`.

| Agent | Project | Every project |
|---|---|---|
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| Codex CLI, Gemini CLI, Cursor, Amp and other agents of the format | `.agents/skills/` | `~/.agents/skills/` |

Some agents also read their own folder (`.gemini/skills/`, `.cursor/skills/`); pass it with `--target`
when a skill is not picked up. See the [documentation](https://appsys-sas.github.io/devtool/agents/skills)
for the details.

The skills name the tools of the server as the server declares them (`list_commands`, `read_terminal`…);
an agent may show them with a prefix, such as `mcp__devtool__list_commands` in Claude Code.
