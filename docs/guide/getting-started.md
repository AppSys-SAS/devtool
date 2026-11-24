---
description: Install the devtool, write a first configuration and open the interface.
---

# Getting started

This page takes you from nothing to a running devtool in a few minutes. You install the command line,
describe one project, and open the interface in your browser.

## Requirements

- Node.js 24 or newer.
- macOS or Linux.
- The tools your own projects need (pnpm, Docker...): the devtool runs them, it does not install them.

## Install

Install the `devtool` command globally with your package manager:

::: code-group

```sh [npm]
npm i -g @appsys/devtool
```

```sh [pnpm]
pnpm add -g @appsys/devtool
```

```sh [yarn]
yarn global add @appsys/devtool
```

```sh [bun]
bun add -g @appsys/devtool
```

:::

::: info Not on npm yet
The package is about to be published. Until then, run the devtool from its sources: see
[Contributing](/reference/contributing).
:::

Check that it works:

```sh
devtool --version
```

## Write your first configuration

The devtool reads its configuration from `~/.config/appsys/devtool`. Create the folder:

```sh
mkdir -p ~/.config/appsys/devtool
```

### The shared file

`config.yml` describes your stack. This one declares a section `acme` (a repository in your workspace)
holding a project `web`, with a dev command and an HTTPS host name:

```yaml [config.yml]
sections:
  acme:
    name: Acme
    path: acme
projects:
  web:
    section: acme
    name: Web
    path: web
    default: { action: command:dev }
    commands:
      dev: { name: Dev server, args: [ pnpm, dev ], startWithSection: true }
    services:
      web: { host: web.example.dev, target: 5173 }
```

The project folder is `<workspace>/acme/web`, and `pnpm dev` runs inside it.

### The personal file

`config.local.yml` holds what is yours only. The devtool needs to know where your repositories live:

```yaml [config.local.yml]
workspace: ~/Workspace
```

::: tip Build it with forms
The [configurator](/configuration/configurator) writes both files for you and checks them as you type.
:::

## Start the devtool

```sh
devtool server
```

Open [http://127.0.0.1:6730](http://127.0.0.1:6730). The sidebar shows the `Acme` section and its `Web`
project. Click the play button of the section header to start the dev server, then click the project to
see its terminal.

The configuration is read again when you save `config.yml` or `config.local.yml`: the sidebar follows.
If a setting is wrong, the devtool keeps going and lists a warning on the Server page.

### Reach the service by its name

`web.example.dev` must point to your machine and reach the load balancer. Two pieces do that:

- the [local DNS](/configuration/network#local-dns) answers your names with your address;
- the load balancer listens on port `6731`, and `devtool proxy` forwards the HTTPS port `443` to it.

Read [Services](/configuration/services) and [Network and DNS](/configuration/network) to set them up,
and [Certificates](/configuration/certificates) to serve HTTPS.

## Share the environment with your team

When a team shares configuration files and data through a CDN, a new developer adds the identity
provider of the team and the CDN to their personal file:

```yaml [config.local.yml]
workspace: ~/Workspace
auth:
  issuer: https://auth.example.dev
  clientId: devtool
cdn:
  url: https://cdn.example.dev
```

Then signs in with the identity provider, pulls everything and starts the server:

```sh
devtool login
devtool env pull --yes
devtool server
```

`devtool env pull` downloads the shared `config.yml` too, so the team keeps one copy of it. Read
[Environment](/configuration/environment), [Sign-in](/configuration/auth) and [CDN](/configuration/cdn) to
set this up.

## Next steps

- Learn the [vocabulary](/guide/concepts) of the devtool.
- Understand [how the files are merged](/configuration/overview).
- Add [commands, scripts and inputs](/configuration/commands) to your projects.
- Connect a [coding agent](/agents/mcp-server).
