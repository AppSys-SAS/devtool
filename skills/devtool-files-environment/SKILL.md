---
name: devtool-files-environment
description: Reads and changes the files the devtool exposes (folders of files of projects, configurations of the environment) through its MCP server, including key-only access to YAML, JSON and .env files that hides secret values, and follows the environment synchronized with a CDN (status, differing keys, pull, push) and the certificates of its load balancer. Use when a task needs a configuration value, a settings file, a database copy or a certificate managed by the devtool.
---

# Devtool files, configuration keys and environment

## Files

- `list_files` lists the spaces: `configs` (configurations of the environment) and the folders of files
  of the projects, `<section>/<project>/<slug>`, with their `type` and your `read` and `write` levels.
  `list_files { space }` lists the files of one space.
- A space of `type: agentSkills` holds one agent skill per folder (`<skill>/SKILL.md`, any case: YAML header with
  `name`, equal to the folder, and `description`, then Markdown instructions); `list_files { space }`
  also gives each skill with its description and what does not follow the format. A `SKILL.md` whose
  header is not a YAML map is refused; `change_files { action: create, kind: directory }` at the root
  creates a skill with its `SKILL.md`.
- `read_file { space, path }` gives the content and its `updatedAt`.
- `read_file { space, path, mode: "keys" }` gives the keys of a YAML, JSON or .env file with the type of
  each value (`<string>`, `<number>`, `<boolean>`, `<list:3>`, `""` for an empty string) instead of the
  value. Where a space is `read: keys`, this is the only way to read it: use it to know which settings
  exist without seeing secrets.
- `write_file { space, path, content, baseUpdatedAt }` replaces a file (creates it when missing); pass
  the `updatedAt` read so that the write is refused when the file changed meanwhile, then read it again.
  The user sees a diff before accepting it when the space asks.
- `update_keys { space, path, changes: [{ key: ["db", "port"], value: 5432 }, { key: ["OLD"], remove: true }] }`
  sets or removes keys while keeping comments and layout; it is allowed where only keys may be written.
- `change_files { space, action: create | remove | rename, path, to?, kind? }`.

Never try to read a secret value another way (shell commands printing it, copying the file elsewhere):
`keys` exists precisely to keep values from agents.

## Environment synchronized with the CDN

- `environment_status`: items (files, databases, buckets, Redis databases), their local and CDN copies,
  whether they are synchronized, and the pull or push running.
- `environment_keys { path }`: keys differing between the local and CDN copies of a configuration file
  (types only where the environment is `read: keys`).
- `environment_tables { path }`: tables of a local database, key groups of a Redis database.
- `environment_sync { direction: pull | push, targets: [{ path, tables? }] }` starts a pull (CDN copies
  replace local ones) or a push; a push, and `pull_shared_config`, are always confirmed by the user.
  Follow the progress with `environment_status`.

Synchronizing overwrites data: only pull or push what the task needs, and say what will be replaced.

## Certificates and configuration

- `list_certificates`: expiry, issuer, errors and renewal of the certificates of the load balancer;
  `renew_certificate { name }` renews one in a terminal.
- `list_pull_requests`: the open pull requests of the repositories of the projects, as last read from
  their forge (author, branches, draft, checks, review, review requested from the user, written by the user).
- `reload_config` reloads the devtool configuration after its files changed; agents never write the
  devtool configuration itself.
