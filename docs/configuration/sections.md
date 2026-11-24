---
description: Sections group projects in the sidebar - their folder, how to restore it, their integrations and their order.
---

# Sections

A section is a group of projects in the sidebar, with a folder of its own. Most teams make one section
per repository: the projects of the section are the apps and services inside it. The header of a
section starts and stops all of its projects at once.

```yaml [config.yml]
sections:
  acme:
    name: Acme
    path: acme
projects:
  web:
    section: acme
    commands:
      dev: { args: [ pnpm, dev ] }
```

Here the section folder is `<workspace>/acme`, and the project `web` lives in `<workspace>/acme/web`.

## The folder of a section

`path` is relative to your [`workspace`](/configuration/overview#paths), which you declare in
`config.local.yml`. That way the team shares the same `config.yml` while each developer keeps their
repositories where they like.

```yaml [config.local.yml]
workspace: ~/Workspace
```

A section without `path` uses `sectionPath`, the workspace itself by default. An absolute path or a path
starting with `~/` works too.

::: warning Declare a workspace
Without `workspace`, a relative section path cannot be resolved: the section is skipped with the
warning `is relative to the workspace, which is not declared`.
:::

## Starting and stopping a section

The play button of a section header starts, in every project of the section, the commands declaring
`startWithSection: true` that are not running yet. The stop button stops every running command of the
section.

```yaml [config.yml]
sections:
  acme:
    path: acme
projects:
  api:
    section: acme
    commands:
      dev: { name: API, args: [ pnpm, dev ], startWithSection: true }
      test: { name: Tests, args: [ pnpm, test ] }
  web:
    section: acme
    commands:
      dev: { name: Vite, args: [ pnpm, dev ], startWithSection: true }
```

Starting `acme` starts both dev servers, not the tests.

## Bringing back a missing folder

When a new developer has not cloned a repository yet, its section would be skipped. Give it a `restore`
command, and the section shows greyed in the sidebar with a button running it instead:

```yaml [config.yml]
sections:
  api:
    path: api
    restore: { name: Clone, args: [ git, clone, git@github.com:example/api.git, "%{ADT:PATH}" ] }
```

The command runs in the parent folder, `%{ADT:PATH}` standing for the missing folder. The configuration
is read again when it ends, and the section comes to life.

## Integrations of a section

A section can declare [integrations](/configuration/integrations), such as the pull requests of its
repository, and show them in its header: `icons` as icons at its right, `lines` as rows under it. A
section only names its own integrations.

```yaml [config.yml]
sections:
  acme:
    path: acme
    integrations:
      pulls: { name: Pull requests, type: pullRequests, token: "{{ $(gh auth token) }}" }
      issues: { name: Issues, type: issues, token: "{{ $(gh auth token) }}" }
    icons: [ integration:issues ]
    lines: [ integration:pulls ]
```

The agents these integrations start work in the folder of the section.

## Ordering the content

The content of a section, its `lines` and its projects, is ordered by `sort`:

- `config` (the default of `adt.sidebar.sort`): the lines first, then the projects, in the order of
  your files;
- `name`: everything by name;
- `manual`: the keys of `order` first, then the others in the order of your files. A project is named
  by its slug, a line by its shortcut, such as `integration:pulls`.

```yaml [config.yml]
sections:
  acme:
    path: acme
    sort: manual
    order: [ web, integration:pulls, api ]
```

The Sidebar card of the Server page edits these orders by drag and drop.

## Projects without a section

A project without `section` goes to a section called `Uncategorized`, slug `uncategorized`. Like any
section without a `path`, it lives in the [`sectionPath`](/configuration/overview) of the workspace, so
the folder of such a project is `<workspace>/<project>` by default. Declare `sections.uncategorized`
yourself to give it another name or folder.

A project naming a section that does not exist goes there too, and the devtool warns
`section: names no section, the project is under uncategorized`: check the spelling of the slug.

## Icon and description

`description` is shown on the page of the section. `meta.icon` sets the icon of the section: an
[Iconify](https://icon-sets.iconify.design/) name such as `mdi:rocket`, or a bare Lucide name such as
`rocket`. The default is a folder tree.

```yaml [config.yml]
sections:
  acme:
    path: acme
    description: The Acme product, API and web front.
    meta: { icon: lucide:rocket }
```

## Reference

### `sections.<slug>`

| Key | Type | Default | Description |
|---|---|---|---|
| `name` | text | the slug | Name shown in the sidebar. |
| `description` | text | none | Shown on the page of the section. |
| `path` | path | `sectionPath` | Folder of the section, relative to the workspace. |
| `restore` | `{ name, args }` | none | Command bringing back the missing folder. `name` defaults to `Restore`. |
| `notifications` | boolean | `adt.notifications` | Notify when a command of the section ends. Default of its projects. |
| `mcp` | agent levels | `adt.mcp.default` | What agents may do in the section: see [Agent permissions](/configuration/mcp). |
| `integrations` | map | `{}` | Integrations of the section: see [Integrations](/configuration/integrations). |
| `icons` | list of `integration:<slug>` | `[]` | Integrations shown as icons in the header. |
| `lines` | list of `integration:<slug>` | `[]` | Integrations shown as rows under the header. |
| `sort` | `config`, `name` or `manual` | `adt.sidebar.sort` | Order of the content. |
| `order` | list | `[]` | With `manual`: project slugs and line shortcuts shown first. |
| `meta.icon` | Iconify name | `lucide:folder-tree` | Icon of the section. |

### Warnings

- `projects[<slug>].path: is relative to the workspace, which is not declared (workspace: <folder>)`
- `projects[<slug>].path: must be an absolute directory`, `not a directory`, or the error of a missing
  folder when no `restore` is declared
- `projects[<slug>].restore.args: must be a non-empty array of strings or numbers`
- `projects[<slug>].icons` or `.lines`: `must be a list of <type>:<slug>`, `must be <type>:<slug>`, or
  `<value> names no integration of the section`
- `projects[<slug>].sort: must be config, name, manual`
- `projects[<slug>].order: must be a list`, or `<key> names nothing here`
- `projects[<slug>].directories: contains no valid entries`: none of its projects could be read

A section holding no project is left out of the sidebar.
