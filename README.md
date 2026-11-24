<div align="center">

<a href="https://appsys-sas.github.io/devtool/"><img src="docs/public/logo.svg" alt="Devtool" width="112"></a>

# AppSys Devtool

**Your whole development stack, started from one YAML file.**

Terminals, HTTPS hosts, a shared development environment and permissions for coding agents,
in one local web interface.

[![CI](https://img.shields.io/github/actions/workflow/status/AppSys-SAS/devtool/ci.yml?branch=main&label=CI&logo=githubactions&logoColor=white)](https://github.com/AppSys-SAS/devtool/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@appsys/devtool?color=6f3aff&logo=npm)](https://www.npmjs.com/package/@appsys/devtool)
[![npm downloads](https://img.shields.io/npm/dm/@appsys/devtool?color=6f3aff)](https://www.npmjs.com/package/@appsys/devtool)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-server-20085e)](https://appsys-sas.github.io/devtool/agents/mcp-server)
[![Docs](https://img.shields.io/badge/docs-VitePress-6f3aff?logo=vitepress&logoColor=white)](https://appsys-sas.github.io/devtool/)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-fe5196?logo=conventionalcommits&logoColor=white)](https://www.conventionalcommits.org/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-f66766)](CONTRIBUTING.md)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-f66766)](LICENSE)

[Documentation](https://appsys-sas.github.io/devtool/) ·
[Getting started](https://appsys-sas.github.io/devtool/guide/getting-started) ·
[Configurator](https://appsys-sas.github.io/devtool/configuration/configurator) ·
[Contributing](CONTRIBUTING.md)

</div>

---

## Table of contents

- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)
- [Trademark](#trademark)

## Features

- **One configuration** - Sections, projects, commands and services in a `config.yml` shared by the
  team, personal overrides in `config.local.yml`, split across files with `include`, with editor
  completion from a [JSON schema](https://appsys-sas.github.io/devtool/configuration/overview#editor-completion).
- **Real terminals** - Every command runs in a real terminal you can type into, search and restart. Its
  inputs are asked as buttons, dropdowns or free text when it starts.
- **HTTPS hosts** - A built-in load balancer serves `https://api.example.dev` from your local ports,
  with HTTP/2, WebSockets, a local DNS and certificates renewed by lego.
- **Shared environment** - Configuration files, databases (PostgreSQL, MariaDB, MongoDB), buckets and
  Redis pulled and pushed through the storage of your team (a CDN behind your OpenID Connect sign-in, S3,
  SFTP, git or your own scripts), with optional encryption on your machine.
- **Secrets on demand** - `{{ op://... }}`, `{{ file://... }}` and `{{ $(...) }}` value blocks read
  1Password, files and commands when a command starts, masked in its output.
- **Pull requests and issues** - GitHub and GitLab pull requests and issues of every repository, with
  their timeline, and buttons that hand them to a coding agent.
- **Coding agents** - A built-in [MCP server](https://appsys-sas.github.io/devtool/agents/mcp-server)
  lets Claude Code, Codex, Cursor and others run commands, read terminals and edit files, each action
  allowed, asked or denied by your configuration.

## Install

You need Node.js 24 or later, on macOS or Linux.

```bash
npm install -g @appsys/devtool
```

or `pnpm add -g @appsys/devtool`, `yarn global add @appsys/devtool`, `bun add -g @appsys/devtool`.

## Quick start

Describe your projects in `~/.config/appsys/devtool/config.yml`:

```yaml
sections:
  acme:
    name: Acme
    path: acme
projects:
  web:
    section: acme
    default: { action: command:dev }
    commands:
      dev: { name: Vite, args: [ pnpm, dev ], startWithSection: true }
    services:
      web: { host: web.example.dev, target: 5173, tls: true }
```

Tell the devtool where your repositories live in `~/.config/appsys/devtool/config.local.yml`:

```yaml
workspace: ~/Workspace
```

Then start it and open <http://127.0.0.1:6730>:

```bash
devtool server
```

Not sure where to start? The [configurator](https://appsys-sas.github.io/devtool/configuration/configurator)
builds these files from forms.

## Documentation

| Page | What you find there |
|---|---|
| [Introduction](https://appsys-sas.github.io/devtool/guide/introduction) | what the devtool does and how it is organized |
| [Getting started](https://appsys-sas.github.io/devtool/guide/getting-started) | install, first configuration, first start |
| [Configuration](https://appsys-sas.github.io/devtool/configuration/overview) | every setting, explained with examples |
| [Environment](https://appsys-sas.github.io/devtool/configuration/environment) | share files and databases with the team |
| [Agents](https://appsys-sas.github.io/devtool/agents/mcp-server) | connect a coding agent and decide what it may do |
| [CLI](https://appsys-sas.github.io/devtool/reference/cli) | every `devtool` command |

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to run the devtool from
source, check a change and write commits.

## Security

The devtool is a development tool for the machine of a developer: **do not use it in production**.
[SECURITY.md](SECURITY.md) explains why, and how to report a vulnerability privately.

## License

Copyright 2026 AppSys SAS. Licensed under the [Apache License, Version 2.0](LICENSE).

## Trademark

AppSys is a registered trademark of AppSys SAS. The license covers the code, not the AppSys name or
logos: a fork may describe itself as based on the AppSys Devtool, but not use the name or logos for its
own product or suggest an endorsement by AppSys.

<div align="center">
<br>
<a href="https://appsys.digital"><img src="docs/public/brand/appsys.svg" alt="AppSys" height="28"></a>
<br>
<sub>Made by <a href="https://appsys.digital">AppSys</a>: app development, infrastructure and European hosting.</sub>
</div>
