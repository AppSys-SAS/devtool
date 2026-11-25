---
layout: home
title: Devtool
titleTemplate: AppSys Devtool

hero:
  name: Devtool
  text: Your whole dev stack, one click away
  tagline: Start every service of every repository, serve them over HTTPS on real host names, share the development environment with your team and let coding agents help, all from one YAML file.
  image:
    src: /logo.svg
    alt: Devtool
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Configurator
      link: /configuration/configurator
    - theme: alt
      text: GitHub
      link: https://github.com/AppSys-SAS/devtool

features:
  - icon: 🖥️
    title: Real terminals
    details: Every command runs in a real terminal in your browser. Start a whole section in one click, restart a service, answer prompts, keep the output.
    link: /configuration/commands
    linkText: Commands and scripts
  - icon: 🔒
    title: HTTPS host names
    details: A built-in load balancer serves your projects on names like api.example.dev, with your certificates renewed on their own.
    link: /configuration/services
    linkText: Services
  - icon: 📄
    title: Configuration as code
    details: One YAML file describes your stack. Split it per project, keep personal overrides apart, get completion in your editor.
    link: /configuration/overview
    linkText: Files and merging
  - icon: 🔄
    title: Shared environment
    details: Pull configuration files, databases and buckets from a CDN, S3, SFTP or git, encrypted if you want, so a new developer is ready in three commands.
    link: /configuration/environment/
    linkText: Environment
  - icon: 🔀
    title: Pull requests and issues
    details: See the pull requests waiting for your review and the issues assigned to you, without leaving the devtool.
    link: /configuration/integrations
    linkText: Integrations
  - icon: 🤖
    title: Coding agents
    details: Claude Code, Codex and others drive your terminals through MCP, with permissions you choose for every action.
    link: /agents/mcp-server
    linkText: MCP server
---

## A taste of the configuration

This is all it takes to run an API and its web front, each on its own HTTPS host name. The devtool shows
the `acme` section in its sidebar, and its header starts both dev servers at once.

```yaml [config.yml]
sections:
  acme:
    path: acme
projects:
  api:
    section: acme
    default: { action: command:dev }
    commands:
      dev: { name: Dev server, args: [ pnpm, dev ], startWithSection: true }
    services:
      api: { host: api.example.dev, target: 3000, tls: true }
  web:
    section: acme
    default: { action: command:dev }
    commands:
      dev: { name: Vite, args: [ pnpm, dev ], startWithSection: true }
    services:
      web: { host: web.example.dev, target: 5173, tls: true }
```

Ready to try? Follow [Getting started](/guide/getting-started), or build your own file with the
[configurator](/configuration/configurator).

<style>
.VPHome .vp-doc h2 {
  border-top: none;
  margin-top: 48px;
}

.VPHome .vp-doc {
  max-width: 880px;
  margin: 0 auto;
}
</style>
