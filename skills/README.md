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

Link (or copy) the skill folders where your agent loads skills, for one project or for every project:

| Agent | Project | Every project |
|---|---|---|
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| Codex CLI, Gemini CLI, Cursor, Amp and other agents of the format | `.agents/skills/` | `~/.agents/skills/` |

```bash
mkdir -p ~/.agents/skills ~/.claude/skills
for skill in skills/devtool-*; do
  ln -sfn "$PWD/$skill" ~/.agents/skills/
  ln -sfn "$PWD/$skill" ~/.claude/skills/
done
```

Some agents also read their own folder (`.gemini/skills/`, `.cursor/skills/`); check the documentation of
your agent when a skill is not picked up.

The skills name the tools of the server as the server declares them (`list_commands`, `read_terminal`…);
an agent may show them with a prefix, such as `mcp__devtool__list_commands` in Claude Code.
