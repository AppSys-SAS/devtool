---
description: Projects are the folders of a section - their main command, shortcuts in the sidebar, environment and missing folders.
---

# Projects

A project is a folder of a section, usually one app or service: an API, a web front, a Docker stack.
It is a row in the sidebar and a page in the interface, listing its [commands](/configuration/commands),
[services](/configuration/services), [files](/configuration/files) and
[integrations](/configuration/integrations). This page covers the project itself: where it lives, what
it does by default and how its row looks.

```yaml [config.yml]
sections:
  acme:
    path: acme
projects:
  web:
    section: acme
    name: Web
    default: { action: command:dev }
    commands:
      dev: { name: Vite, args: [ pnpm, dev ] }
```

## The folder of a project

`path` is relative to the folder of its section and defaults to the slug of the project. The project
above lives in `<workspace>/acme/web`. Use another `path` when the folder name differs, or an absolute
path, or one starting with `~/`:

```yaml [config.yml]
projects:
  web:
    section: acme
    path: apps/frontend
  notes:
    section: acme
    path: ~/Documents/notes
```

The folder must exist, unless you tell the devtool how to bring it back.

### Bringing back a missing folder

With `restore`, a missing project shows greyed in the sidebar with a button running the command. It runs
in the parent folder, `%{ADT:PATH}` standing for the missing folder, and the configuration is read again
when it ends.

```yaml [config.yml]
projects:
  desktop:
    section: acme
    path: ../desktop
    restore: { name: Clone, args: [ git, clone, git@github.com:example/desktop.git, "%{ADT:PATH}" ] }
```

## The main command

`default` says what the project does by default. Point it at a command, and that command becomes the
**main command** of the project: the sidebar row shows whether it runs, and offers to stop and restart
it.

```yaml [config.yml]
projects:
  api:
    section: acme
    default: { action: command:dev }
    commands:
      dev: { name: Dev server, args: [ pnpm, dev ] }
```

`trigger` says how you run it from the sidebar:

- `icon` (default): from a button shown when you hover the row;
- `row`: with a click on the row, which then no longer opens the project page (a main command already
  running still opens it);
- `row-icon`: both.

`default` also accepts the other shortcuts below. A folder of secrets opened by a click on its row:

```yaml [config.yml]
projects:
  secrets:
    section: acme
    path: ~/secrets
    default: { action: files:secrets, trigger: row }
    files:
      secrets: { path: . }
```

## Shortcuts in the sidebar

A project puts what it declares on its sidebar row: `icons` as icons at the right of the row, `lines` as
rows under it, in the order of the list. Each item is a shortcut, `<type>:<slug>`:

| Shortcut | Does | Default icon |
|---|---|---|
| `command:<slug>` | Runs the command | Play |
| `files:<slug>` | Opens the folder of files | Open folder |
| `integration:<slug>` | Opens the integration | A generic integration icon |
| `service:<slug>[:<index>]` | Opens the host at that index of the service (`0` by default) in a new tab | Globe |

```yaml [config.yml]
projects:
  docker:
    section: acme
    default: { action: command:up }
    commands:
      up: { name: Compose up, args: [ docker, compose, up ] }
      logs: { name: Logs, args: [ docker, compose, logs, -f ] }
    services:
      mailpit: { host: mail.example.dev, target: 8025 }
    integrations:
      redis: { name: Redis Insight, icon: devicon:redis, url: "https://redis.example.dev" }
    files:
      data: { path: data }
    icons: [ integration:redis, service:mailpit ]
    lines: [ command:logs, files:data ]
```

`default.icon` replaces the icon of the default button: an [Iconify](https://icon-sets.iconify.design/)
name, or `own` for the icon of the integration it opens.

## Environment, shell and stop signal

`env` gives environment variables to everything that runs in the project: its commands, its scripts and
the terminals you open on it. It is a map, or a list of maps merged in order. A command adds its own
[`env`](/configuration/commands#environment) on top, its values winning over those of the project.

```yaml [config.yml]
projects:
  api:
    section: acme
    env:
      NODE_ENV: development
    shell: /bin/bash
    killSignal: SIGINT
    scripts: [ scripts ]
```

::: warning Quote every value
If a single value of `env` is not a text, the whole `env` is ignored: quote numbers and booleans,
`PORT: "3000"`.
:::

`shell` is the default shell of the commands and scripts of the project. `killSignal` is the signal that
stops its scripts and terminals, `SIGTERM` by default.

## Notifications, icon and description

- `notifications: false` stops the notifications of the project's commands; the default comes from its
  section.
- `description` is shown on the project page.
- `meta.icon` sets the icon of the row: an Iconify name, or a bare Lucide name.

```yaml [config.yml]
projects:
  web:
    section: acme
    description: The customer-facing web app.
    notifications: false
    meta: { icon: lucide:globe }
```

## Reference

### `projects.<slug>`

| Key | Type | Default | Description |
|---|---|---|---|
| `section` | section slug | `uncategorized` | Section holding the project. See [Sections](/configuration/sections#projects-without-a-section). |
| `name` | text | the slug | Name shown in the sidebar. |
| `description` | text | none | Shown on the project page. |
| `path` | path | the slug | Folder of the project, relative to its section. |
| `restore` | `{ name, args }` | none | Command bringing back the missing folder. `name` defaults to `Restore`. |
| `notifications` | boolean | from the section | Notify when a command of the project ends. |
| `env` | map, or list of maps | `{}` | Variables of the commands, scripts and terminals of the project. |
| `shell` | path | `adt.shell` | Shell of the commands and scripts. |
| `killSignal` | `SIG...` | `SIGTERM` | Signal stopping the scripts and terminals. |
| `mcp` | agent levels | from the section | What agents may do here: see [Agent permissions](/configuration/mcp). |
| `default` | map | none | What the project does by default: see below. |
| `commands` | map | `{}` | See [Commands and scripts](/configuration/commands). |
| `scripts` | list | `[]` | See [Commands and scripts](/configuration/commands#scripts). |
| `services` | map | `{}` | See [Services](/configuration/services). |
| `files` | map | `{}` | See [Files](/configuration/files). |
| `integrations` | map | `{}` | See [Integrations](/configuration/integrations). |
| `icons` | list of shortcuts | `[]` | Shortcuts shown as icons at the right of the row. |
| `lines` | list of shortcuts | `[]` | Shortcuts shown as rows under the project. |
| `meta.icon` | Iconify name | `lucide:folder-tree` | Icon of the row. |

### `projects.<slug>.default`

| Key | Type | Default | Description |
|---|---|---|---|
| `action` | shortcut | required | `command:<slug>` makes it the main command; `files:`, `integration:` and `service:` work too. |
| `trigger` | `icon`, `row` or `row-icon` | `icon` | Run it from a button, a click on the row, or both. |
| `icon` | Iconify name or `own` | the icon of the shortcut | Icon of the default button. |

### Warnings

The devtool names a project `projects[<section>].directories[<project>]` in its warnings.

- `.section: names no section, the project is under uncategorized`
- `.path: must be an absolute directory`, `not a directory`, or the error of a missing folder when no
  `restore` is declared
- `.restore.args: must be a non-empty array of strings or numbers`
- `.killSignal: must match SIG* format (example: SIGTERM, SIGKILL)`
- `.icons` or `.lines: <value> names no integration, command, files or service host of the directory`
- `.default.trigger: must be icon, row or row-icon`
- `.default.icon: must be own or an Iconify name <prefix>:<name>`
- `.commands.default: is replaced by default: { action: command:<slug> }`: `default` is not a command
  slug, it is the `default` setting of the project.
