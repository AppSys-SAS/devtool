---
description: Where the devtool reads its configuration, how files are merged, and how paths and variables are resolved.
---

# Files and merging

The devtool configuration is plain YAML, spread over as few or as many files as you like. This page
explains where the devtool looks for them, in which order they are merged, and how paths and
environment variables inside them are resolved. Read it once before you split a configuration or share
it with a team.

## The configuration folder

The devtool reads everything from one folder, the first of:

1. `--config-folder <folder>`, an option every `devtool` command accepts;
2. the `ADT_CONFIG_FOLDER` environment variable;
3. `~/.config/appsys/devtool`.

Nothing is read from where the devtool is installed. The folder holds two files, plus what the
devtool keeps for itself (`session.json` for your [sign-in](/configuration/auth), `sync.json` for the
environment synchronization):

| File | Holds | Shared |
|---|---|---|
| `config.yml` | The configuration of the team: sections, projects, environment, agents. | Yes, often through a [backend](/configuration/environment/backends) of the environment |
| `config.local.yml` | Your own settings and overrides: `workspace`, extra DNS names, a different port. | Never |

A missing file is skipped, so a fresh machine can start with `config.local.yml` alone.

```yaml [config.local.yml]
workspace: ~/Workspace
```

::: tip Several setups on one machine
`devtool server` also takes the files to load as arguments, in order:
`devtool server ./shared.yml ./mine.local.yml`. They replace the two default files; the last one ending
in `.local.yml` is treated as your personal file.
:::

## Including other files

`include` lists more files to merge into the one declaring it. Paths are relative to the file that
declares them, and accept globs, `~/` and `$VARIABLES`:

```yaml [config.yml]
include: [ config/*.yml, projects/*.yml ]
```

- Files matching a glob are loaded in alphabetical order.
- An included file may include others.
- A pattern matching nothing is ignored, and a file is never loaded twice.

A repository can keep its own part of the configuration and have every developer include it:

```yaml [config.local.yml]
workspace: ~/Workspace
sectionPath: acme/monorepo
include: [ ~/Workspace/acme/monorepo/.devtool/*.yml ]
```

## The merge order

Files are merged one over the other, the later one winning:

1. `config.yml`;
2. the files `config.yml` includes, in order;
3. `config.local.yml`;
4. the files `config.local.yml` includes.

So an included file overrides the file that includes it, and your personal file overrides everything.

### How values are merged

- **Maps are merged key by key.** A personal file can change one setting of a project without
  repeating the others.
- **A value replaces the value under it**, `null` included.
- **Lists are merged item by item, by position.** They are not replaced.

::: warning Lists merge by position
With this shared file:

```yaml [config.yml]
projects:
  web:
    commands:
      dev: { args: [ pnpm, dev, --host, 0.0.0.0 ] }
```

and this personal file:

```yaml [config.local.yml]
projects:
  web:
    commands:
      dev: { args: [ yarn, dev ] }
```

the command becomes `yarn dev --host 0.0.0.0`: the first two items are replaced, the last two are kept.
To shorten a list, override every item, or give the command another slug.
:::

This rule has a use. In the lists accepting a short form, such as `environment.files`, a personal file
can add settings to an item at the same position. A text in the shared file and a map in the personal
file give `{ path: <the text>, ...the map }`:

```yaml [config.yml]
environment:
  files: [ devtool/config.yml, api/config.yml ]
```

```yaml [config.local.yml]
environment:
  files: [ { sync: false } ]
```

Here `devtool/config.yml` is kept but no longer synchronized on your machine.

## Paths

Relative paths are resolved from a fixed place, whichever file declares them:

| Setting | Resolved from |
|---|---|
| `workspace`, `adt.cacheDir`, `adt.icon`, `environment.folder` | The configuration folder |
| `loadBalancers.<domain>.crt` and `.key` | The configuration folder (a PEM text is kept as is) |
| `sections.<slug>.path` | The `workspace` |
| `projects.<slug>.path` | The folder of its section |
| Folders of `scripts` and `files` | The folder of their project |

A section without `path` uses `sectionPath`, itself relative to the workspace (`.` by default: the
workspace itself). Without `workspace`, relative section paths cannot be resolved and the devtool warns.

## Variables and `~`

When a file is loaded, every text value is expanded:

- a value starting with `~/` becomes a path in your home folder;
- `$NAME` and `${NAME}` are replaced by the environment variable of the devtool, when it is defined, and
  left as written otherwise.

```yaml [config.yml]
projects:
  web:
    path: ~/Workspace/web
    env:
      API_URL: https://api.example.dev
      EDITOR: $EDITOR
```

::: warning Expanded when loaded, not when run
`args: [ sh, -c, "echo $PATH" ]` prints the `PATH` of the devtool, frozen when the configuration was
read, not the one of the shell running the command. To read a variable when the command runs, use a
[value block](/configuration/automation#value-blocks): <code v-pre>"{{ $(printenv PATH) }}"</code>.
:::

## Splitting the configuration

A team with many projects usually keeps one file per project, so a change touches one small file:

```text
~/.config/appsys/devtool/
├── config.yml             adt, auth, environment... and include
├── config.local.yml       your workspace
├── config/
│   └── sections.yml       every section
└── projects/
    ├── api.yml            projects: { api: ... }
    └── web.yml            projects: { web: ... }
```

```yaml [config.yml]
include: [ config/*.yml, projects/*.yml ]
adt:
  displayName: Acme Devtool
```

```yaml [config/sections.yml]
sections:
  acme: { name: Acme, path: acme }
```

```yaml [projects/web.yml]
projects:
  web:
    section: acme
    commands:
      dev: { args: [ pnpm, dev ] }
```

The [configurator](/configuration/configurator) writes this layout for you with **One file per
project**.

::: tip Reloading
The devtool reads its configuration again on its own when `config.yml` or `config.local.yml` changes.
After changing an included file, restart `devtool server`, or save one of those two files.
:::

## Editor completion

The devtool publishes a JSON Schema of its configuration. Add this line at the top of a configuration
file to get completion, descriptions and errors in your editor:

```yaml [config.yml]
# yaml-language-server: $schema=https://appsys-sas.github.io/devtool/schema/config.json
adt:
  displayName: Acme Devtool
```

- **VS Code**: install the YAML extension by Red Hat.
- **JetBrains IDEs**: the line works out of the box.
- The schema also ships in the npm package, at `@appsys-sas/devtool/dist/schema/config.schema.json`.

## Warnings

The devtool never stops on a wrong setting. It skips what it cannot use and lists a warning on the
Server page, such as `projects[acme].directories[web].extras[dev].args: must be an array of strings,
numbers or inputs.` The warning names the setting with the internal words of the devtool: a section is
`projects[<section>]`, a project `directories[<project>]`, a command `extras[<command>]` and a service
`services[<service>]`.

A key the devtool does not know is ignored without a warning: a typo such as `comands` silently does
nothing. The schema catches those, in your editor and in the configurator.

## Reference

### Top-level keys

| Key | Type | Default | Description |
|---|---|---|---|
| `workspace` | path | none | Folder of your repositories. Usually in `config.local.yml`. |
| `sectionPath` | path | `.` | Path, from the workspace, of the sections declaring none. |
| `include` | list of paths | `[]` | Files merged over this one, relative to it. Globs allowed. |
| `adt` | map | | The devtool itself: see [The devtool](/configuration/devtool). |
| `sections` | map | | See [Sections](/configuration/sections). |
| `projects` | map | | See [Projects](/configuration/projects). |
| `integrations` | map | | Web tools of the whole devtool: see [Integrations](/configuration/integrations). |
| `loadBalancers` | map | | Certificates by domain: see [Certificates](/configuration/certificates). |
| `passthrough` | list | | See [Network and DNS](/configuration/network). |
| `dns` | map | | See [Network and DNS](/configuration/network#the-local-dns). |
| `environment` | map | | See [Environment](/configuration/environment/), [Backends](/configuration/environment/backends) and [Encryption](/configuration/environment/encryption). |
| `auth` | map | | See [Sign-in](/configuration/auth). |

### Errors when loading

- `expected a single document in "<file>", but found more`: a file holds several YAML documents
  separated by `---`. Keep one per file.
- `projects[<section>].path: is relative to the workspace, which is not declared`: add `workspace` to
  `config.local.yml`.
