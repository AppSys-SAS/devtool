---
description: Agent skills shipped with the devtool, and how to install them in Claude Code, Codex, Gemini CLI or Cursor.
---

# Agent skills

The [MCP server](/agents/mcp-server) gives an agent tools; skills teach it when and how to use them:
wait for a dev server before testing, read only the new output of a terminal, never ask for a secret
value. The repository ships three skills in its
[`skills`](https://github.com/AppSys-SAS/devtool/tree/main/skills) folder. They follow the open Agent
Skills format (a folder per skill holding a `SKILL.md`), so the same folders work in Claude Code, Codex
CLI, Gemini CLI, Cursor and the other agents that read it.

| Skill | Use it to |
|---|---|
| `devtool-mcp-setup` | connect an agent to the devtool, and configure what agents may do (`adt.mcp`) |
| `devtool-terminals` | run commands and scripts, follow and drive terminals, debug a failing service, free a port |
| `devtool-files-environment` | read and change project files, configuration keys without their secret values, the CDN environment and certificates |

## Install them

Link (or copy) the skill folders where your agent loads skills, for one project or for every project:

| Agent | One project | Every project |
|---|---|---|
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| Codex CLI, Gemini CLI, Cursor, Amp and other agents of the format | `.agents/skills/` | `~/.agents/skills/` |

From a clone of the repository:

```bash
mkdir -p ~/.agents/skills ~/.claude/skills
for skill in skills/devtool-*; do
  ln -sfn "$PWD/$skill" ~/.agents/skills/
  ln -sfn "$PWD/$skill" ~/.claude/skills/
done
```

Links keep the skills up to date when you pull the repository. Some agents also read their own folder
(`.gemini/skills/`, `.cursor/skills/`): check the documentation of your agent when a skill is not picked
up.

::: tip Tool names
The skills name the tools as the server declares them (`list_commands`, `read_terminal`...). Your agent
may show them with a prefix, such as `mcp__appsys-devtool__list_commands` in Claude Code.
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
