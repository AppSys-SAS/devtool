---
description: The vocabulary of the devtool and how its pieces fit together.
---

# Concepts

The devtool uses a handful of words everywhere: in the configuration, in the interface and in this
documentation. Learn them once and every other page reads easily.

## The building blocks

```text
config.yml
├── sections            groups in the sidebar, usually one repository each
│   └── projects        folders of a section, usually one app or service each
│       ├── commands    what you run: dev servers, tests, builds
│       ├── scripts     folders of executables, listed as commands
│       ├── services    host names the load balancer serves for the project
│       ├── files       folders you browse and edit in the interface
│       └── integrations web tools, pull requests and issues
├── integrations        web tools shown for the whole devtool
├── environment         files and data shared with the team through the CDN
├── auth                how you sign in, with your company account
├── cdn                 where the environment lives
└── adt                 the devtool itself: name, ports, sidebar, agents
```

| Word | What it is | Where to read more |
|---|---|---|
| Section | A group of projects in the sidebar, with its own folder. Starting a section starts its commands marked `startWithSection`. | [Sections](/configuration/sections) |
| Project | A folder with its commands, services, files and integrations. A row in the sidebar. | [Projects](/configuration/projects) |
| Command | A command line run in a terminal, in the folder of its project. It may ask for inputs first. | [Commands and scripts](/configuration/commands) |
| Script | An executable file of a folder you point at. Each one becomes a command, and new files show up on their own. | [Commands and scripts](/configuration/commands#scripts) |
| Service | A host name, such as `api.example.dev`, and where its requests go, such as port `3000`. | [Services](/configuration/services) |
| Files | A folder you can browse and edit from the interface, or a folder of agent skills. | [Files](/configuration/files) |
| Integration | A web tool shown inside the devtool, or the pull requests and issues of a repository. | [Integrations](/configuration/integrations) |
| Environment | The files, database dumps and bucket snapshots every developer needs, kept in a local folder. | [Environment](/configuration/environment) |
| Sign-in | Your session with the identity provider of the team, used by the CDN and readable by commands. | [Sign-in](/configuration/auth) |
| CDN | The server storing the shared environment, reached with your sign-in. | [CDN](/configuration/cdn) |
| Agent | A coding agent, such as Claude Code, that drives the devtool through its MCP server. | [MCP server](/agents/mcp-server) |

Every entry of a map has a **slug**: its key in the YAML file, such as `web` in `projects: { web: ... }`.
Slugs identify things everywhere: in shortcuts (`command:dev`), in the MCP tools, in the URL of a page.

## How it maps to the sidebar

```text
▾ Acme                      ← section "acme" (its header starts and stops it)
    ● API          ▶        ← project "api", its main command running, a play shortcut
    ○ Web          🌐       ← project "web", stopped, a shortcut opening its site
      Pull requests  3      ← a line under the project: an integration with its badge
▸ Tools                     ← another section, folded
```

- A project shows the state of its **main command**, the one its `default` names.
- `icons` puts shortcuts at the right of a row, `lines` puts rows under it.
- A section or a project whose folder is missing, and which declares how to `restore` it, shows greyed
  with a button to bring it back.

## How a request reaches a service

```text
browser ── https://api.example.dev ──▶ devtool proxy (:443)
                                           │
                                           ▼
                                  load balancer (:6731) ── picks the service by host name
                                           │
                                           ▼
                                  target 127.0.0.1:3000   (your dev server)
```

1. The [local DNS](/configuration/network#local-dns), or your own, resolves `api.example.dev` to your
   machine.
2. `devtool proxy` listens on the HTTPS port `443` and forwards the connection to the load balancer.
   You can also open the load balancer port directly.
3. The load balancer serves the [certificate](/configuration/certificates) of the domain, finds the
   [service](/configuration/services) declaring the host, and forwards the request to its target.

The interface itself listens on `127.0.0.1:6730`, on this machine only.
