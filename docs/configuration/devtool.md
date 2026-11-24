---
description: Settings of the devtool itself under adt - name, icon, ports, cache, shell, notifications and the sidebar.
---

# The devtool (`adt`)

The `adt` map holds the settings of the devtool itself rather than of your projects: the name it shows,
its icon, the ports it listens on, the default shell of your commands and what the sidebar shows. Every
setting has a sensible default, so you only add what you want to change.

```yaml [config.yml]
adt:
  displayName: Acme Devtool
  icon: assets/icon.svg
```

Agents have their own pages: [Agent permissions (MCP)](/configuration/mcp) covers `adt.mcp`, and
[Integrations](/configuration/integrations#agents) covers `adt.agents` and `adt.agentPrompts`.

## Name and icon

The devtool shows `displayName` in the browser tab, the sidebar, the notifications and, on macOS, as the
name of its application. `name` identifies it to programs: it names the MCP server agents connect to,
and the macOS application. By default it is the display name in lowercase with hyphens, so
`Acme Devtool` gives `acme-devtool`.

```yaml [config.yml]
adt:
  displayName: Acme Devtool
  name: acme-devtool
  icon: assets/icon.svg
```

`icon` is an SVG, PNG, JPEG or ICNS file, relative to the configuration folder. It becomes the favicon,
the icon of the notifications and the icon of the macOS application.

### The macOS application

On macOS, `devtool server` starts the server again, detached, inside a small application named after
`displayName`. The devtool builds it in its cache folder: its executable is a link to Node and its icon is
`adt.icon`. The process you started only relays its stop to the application and ends with it.

Why: macOS and 1Password name the process at the top of the tree. With the application, a 1Password
prompt says "Acme Devtool" for everything the devtool runs, including your own commands calling `op`.

## Ports and access

The devtool listens on two ports:

| Port | Default | Listens on | Serves |
|---|---|---|---|
| `adt.ports.server` | `6730` | `127.0.0.1` | The interface and the MCP server |
| `adt.ports.loadBalancer` | `6731` | every interface | Your [services](/configuration/services), over HTTPS once you declare a [certificate](/configuration/certificates) |

```yaml [config.local.yml]
adt:
  ports:
    server: 7730
    loadBalancer: 7731
```

`devtool server -g <port>` and `-l <port>` override them for one run.

To open the interface on a host name through the load balancer, for instance from a phone on your
network, give it `host`, and `access: network` to let other machines in:

```yaml [config.local.yml]
adt:
  host: devtool.example.dev
  access: network
```

`devtool server --ssl devtool.example.dev` sets `host` for one run.

::: warning Who gets in
`access` is checked against the address of the connection, never against a forwarded header. With
`network`, anyone who can reach your machine can open the interface and run your commands. Keep `local`
unless you need it.
:::

## The cache folder

`cacheDir` holds what the devtool rebuilds or keeps between runs. You rarely need to change it.

- the macOS application and its icons (`app-icons/`);
- lego, the certificate tool, and the accounts and certificates it manages (`lego/`, `acme/`);
- the history of agent calls and the permissions you granted (`mcp-history.jsonl`, `mcp-grants.json`,
  `mcp-clients.json`).

Every command receives the folder as `APPSYS_DEVTOOL_CACHE_DIR`, so a `docker-compose.yml` of your
environment can keep its volumes there.

## Shell and notifications

Commands run in a shell: `adt.shell`, else your `$SHELL`, else the first of `/bin/zsh`, `/bin/bash`
and `/bin/sh`. A project or a command can choose another one.

`notifications` sends a system notification when a command ends. It is on by default, and is the default
of every section, project and command, which can turn it off for themselves.

```yaml [config.yml]
adt:
  shell: /bin/bash
  notifications: false
```

### What your commands receive

Besides their own `env`, commands get:

| Variable | Value |
|---|---|
| `APPSYS_DEVTOOL` | `true`, to tell a script it runs inside the devtool |
| `APPSYS_DEVTOOL_CACHE_DIR` | The [cache folder](#the-cache-folder) |
| `FORCE_COLOR` | `3`, so tools keep their colors in the terminal |
| `TERM` | `xterm-256color` |

## The sidebar

`adt.sidebar` shows optional links, all hidden by default, and orders the sections:

```yaml [config.yml]
adt:
  sidebar:
    environment: true
    configs: true
    login: true
    sort: manual
    order: [ acme, tools ]
```

- `environment` and `configs` add links to the Environment and Configs pages. The pages stay reachable
  by their address either way.
- `login` shows whether you are signed in to the [CDN](/configuration/cdn).
- `sort` orders the sections: `config` (the order of your files), `name`, or `manual`. With `manual`,
  the slugs of `order` come first, then the others in the order of your files.
- `sort` is also the default order of the content of every [section](/configuration/sections#ordering-the-content).

::: tip Order by drag and drop
The Sidebar card of the Server page edits these orders: choose the file to write (Personal or Shared),
drag the items, then save.
:::

## Reference

### `adt`

| Key | Type | Default | Description |
|---|---|---|---|
| `displayName` | text without `/` | `AppSys Devtool` | Name shown in the tab, the sidebar, the notifications and the macOS app. |
| `name` | lowercase letters, digits, `-`, `_` | the display name in lowercase | Name of the MCP server and identifier of the macOS app. |
| `icon` | path to `.svg`, `.png`, `.jpg`, `.jpeg` or `.icns` | none | Favicon, notification and app icon, relative to the configuration folder. |
| `cacheDir` | path | `~/.cache/appsys/devtool` | Folder the devtool keeps its own files in. |
| `host` | host name | none | Host serving the interface through the load balancer. |
| `access` | `local` or `network` | `local` | Who may open the interface through `host`. |
| `ports.server` | port | `6730` | Port of the interface and the MCP server, on `127.0.0.1`. |
| `ports.loadBalancer` | port | `6731` | Port of the load balancer, on every interface. |
| `shell` | path | `$SHELL` | Default shell of the commands. |
| `notifications` | boolean | `true` | Notify when a command ends. |
| `sidebar` | map | | See below. |
| `mcp` | map | | See [Agent permissions (MCP)](/configuration/mcp). |
| `agents`, `agentPrompts` | map | | See [Integrations](/configuration/integrations#agents). |

### `adt.sidebar`

| Key | Type | Default | Description |
|---|---|---|---|
| `environment` | boolean | `false` | Link to the Environment page. |
| `configs` | boolean | `false` | Link to the Configs page. |
| `login` | boolean | `false` | CDN sign-in state. |
| `sort` | `config`, `name` or `manual` | `config` | Order of the sections, and default order of their content. |
| `order` | list of section slugs | `[]` | With `manual`, the sections shown first. |

### Warnings

- `adt.displayName: must be a text without /`
- `adt.name: must hold lowercase letters, digits, - and _ only`
- `adt.icon: must be a .svg, .png, .jpg, .jpeg, .icns file`, or `<path> does not exist`
- `adt.access: must be local or network, local is used`
- `adt.shell: is not a string`
- `adt.sidebar.<key>: is not a boolean`
- `adt.sidebar.sort: must be config, name, manual`
- `adt.sidebar.order: must be a list`, or `<slug> names nothing here`

An invalid port or `notifications` value is ignored without a warning: the default is used.
