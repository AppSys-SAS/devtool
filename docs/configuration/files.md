---
description: Edit the files of a project from the devtool, preview Markdown, and manage agent skills.
---

# Files

A folder of files gives a project an editor inside the devtool: configuration files, `.env` files,
documentation, prompts. You open it from the project page or from a button of the sidebar, without
switching to your IDE.

With `type: agentSkills`, the same folder becomes an editor of agent skills, the instructions coding
agents such as Claude Code or Codex load.

## A first folder of files

```yaml [config.yml]
projects:
  api:
    files:
      config: { name: Configuration, path: config }
```

`config` is the slug of the folder, `path` is relative to the project. The folder may not exist yet:
the devtool still lists it, and `restore` (below) can bring it back.

The page of a folder lists its files and edits them. A Markdown file (`.md`, `.markdown`) shows a
**Preview** button that renders it next to the editor; its YAML front matter is left out of the
preview. The preview is off until you turn it on.

## Open the files from the sidebar

Use the [shortcut](/configuration/projects) `files:<slug>`: as an icon of the project row, as a row under
it, or as what the project does by default.

```yaml [config.yml]
projects:
  secrets:
    path: ~/secrets
    default: { action: "files:env", trigger: row }
    files:
      env: { name: Environment files, path: . }
```

Here a click on the **secrets** row opens its files directly.

## Commands next to the files

`commands` shows buttons for some commands of the project on the page of the folder, for instance to
reload the configuration you just changed. `restore` names a command that brings the folder back when
it is missing, such as a `git clone` or a download.

```yaml [config.yml]
projects:
  secrets:
    path: ~/secrets
    commands:
      pull: { name: Pull secrets, args: [ ./pull.sh ] }
      check: { name: Check, args: [ ./check.sh ] }
    files:
      env: { name: Environment files, path: env, restore: pull, commands: [ check ] }
```

::: warning `default` is not a slug of files
A folder of files named `default` is refused, with the warning
`is replaced by default: { action: files:<slug> }`. Use another slug, and name it in the `default` of
the project.
:::

## Agent skills

An agent skill is a folder holding a `SKILL.md`: a YAML header with a `name` and a `description`, then
the instructions in Markdown. Agents read the description to decide when to load the skill.

```yaml [config.yml]
projects:
  agents:
    path: ~/.agents
    files:
      skills: { name: Skills, path: skills, type: agentSkills }
  api:
    files:
      skills: { name: Skills, path: .claude/skills, type: agentSkills }
```

```md [skills/release-notes/SKILL.md]
---
name: release-notes
description: Writes the release notes of a version from its merged pull requests.
---

List the pull requests merged since the last tag, group them by type, then...
```

With `type: agentSkills`, each folder at the root of `path` is one skill. The page lists the skills with
their description, and points out what does not follow the format:

- the file does not start with a YAML header between `---` lines, or the header is not a YAML map;
- `name` is missing, does not match the folder, or is not made of lowercase letters, digits and single
  hyphens (64 characters at most);
- `description` is missing, or longer than 1024 characters.

You edit a skill as a **form** (name, description, instructions) or as its **source**. Other keys of the
header are kept as they are. A `SKILL.md` whose header is not a YAML map is not saved. Creating a new
folder at the root creates a new skill, with its `SKILL.md`.

The `SKILL.md` file is found whatever the case of its name.

::: tip The devtool ships its own skills
The [agent skills](/agents/skills) of the devtool teach agents to use its MCP server. Declare their
folder with `type: agentSkills` to read and edit them here.
:::

## What agents may do with the files

`mcp` sets what agents connected to the [MCP server](/agents/mcp-server) may do with the folder. Folders
of files accept a level of their own, `keys`: agents see the keys of the files and the type of each
value, never the values, and change them with `update_keys` only. See
[Agent permissions](/configuration/mcp).

```yaml [config.yml]
projects:
  api:
    files:
      config: { name: Configuration, path: config, mcp: { read: keys, write: keys } }
```

## Reference

### `projects.<project>.files.<slug>`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | string | the slug | Title of the page. |
| `path` | string | required | Folder, relative to the project. It may not exist yet. |
| `type` | `files` or `agentSkills` | `files` | A plain editor, or one agent skill per folder. |
| `restore` | command slug | | Command of the project restoring the folder when it is missing. |
| `commands` | list of command slugs | | Commands of the project shown on the page. |
| `mcp` | level or levels | inherited | What agents may do; `keys` is allowed. |
| `mcpSkills` | `true` or list of globs | `false` | `agentSkills` only: [serve its skills over MCP](/agents/skills#serve-them-over-mcp). |

### Warnings

- `is replaced by default: { action: files:<slug> }`: a folder of files is named `default`.
- `type: must be files or agentSkills`: the folder is dropped.
- `mcpSkills: only applies to files of type agentSkills`,
  `mcpSkills: must be true or a list of skill folders, such as [ review, "deploy-*" ]`: no skill is served.
- `restore: must name a command of the directory`.
- `commands: unknown commands <slugs>`: the unknown ones are left out.
