---
description: What the devtool is, the problem it solves and the ideas behind it.
---

# Introduction

The devtool is a local development environment you run on your own machine. It starts the services of
your projects, serves them on HTTPS host names, keeps the files and data your team shares in sync, and
lets coding agents work with all of it. You describe your stack once, in a YAML file, and the devtool
gives you a web interface to drive it.

## The problem it solves

A real product is rarely one repository. You have an API, a web front, a worker, a database in Docker,
a mail catcher, maybe an admin app. Every morning you open a handful of terminals, start each piece in
the right order, look for the port of each one, and copy the latest configuration a teammate sent you.
A new developer spends days getting there.

The devtool turns that into a sidebar:

- **One place to start everything.** Each project lists its commands. Starting a section starts every
  command it needs; stopping it stops them all.
- **Real host names over HTTPS.** Instead of `localhost:5173` and `localhost:3000`, you open
  `https://web.example.dev` and `https://api.example.dev`. Cookies, CORS and OAuth callbacks behave
  like in production.
- **A shared environment.** Configuration files, database dumps and bucket snapshots live on a CDN.
  One command brings a fresh machine up to date.
- **Agents that can help.** Coding agents connect over MCP to read your terminals, run your commands
  and edit your files, each action allowed, asked or denied as you decide.

## Who it is for

Teams working on several repositories at once, who want every developer to run the same stack the same
way. It also suits a solo developer who is tired of juggling terminals. The devtool runs on macOS and
Linux.

## The main ideas

**One YAML file.** Everything starts from `config.yml`. You can split it into several files with
`include`, and the [configurator](/configuration/configurator) writes one for you.

**Sections, then projects.** A [section](/configuration/sections) is a group in the sidebar, usually one
repository. It holds [projects](/configuration/projects), usually one folder each. A project declares:

- [commands](/configuration/commands) and folders of scripts you can run;
- [services](/configuration/services), the host names the load balancer serves for it;
- [files](/configuration/files) you can browse and edit;
- [integrations](/configuration/integrations), web tools, pull requests and issues.

**Personal overrides.** `config.yml` is shared by the team. `config.local.yml` holds what is yours: where
your repositories live, extra DNS names, a different port. It is merged last, so it wins. Read
[Files and merging](/configuration/overview) for the details.

## What you see in the interface

- **The sidebar** lists your sections and their projects. A dot shows whether the main command of a
  project runs. Hovering a row shows its shortcuts: start the command, open the files, open the site.
- **The project page** lists the commands, scripts, services, files and integrations of a project.
- **Terminals** open in tabs. They keep running when you close the browser, and you get a
  notification when a command ends.
- **The Server page** shows the certificates, the ports, the warnings about your configuration and the
  order of the sidebar.
- **The Environment page** compares your local files, databases and buckets with the CDN and lets you
  pull or push them.
- **The Agents page** shows which coding agents are connected, what they asked and what you allowed.

Next: [install the devtool](/guide/getting-started) and write your first configuration.
