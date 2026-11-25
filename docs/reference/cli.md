---
description: Every command and option of the devtool CLI, and the environment variables it reads and sets.
---

# CLI

The `devtool` command starts the server and handles everything that happens outside the interface:
signing in, synchronizing the environment, renewing certificates.

```bash
devtool --help
devtool env pull --help
```

## Global options

| Option | Description |
|---|---|
| `--config-folder <folder>` | Configuration folder, else `$ADT_CONFIG_FOLDER`, else `~/.config/appsys/devtool`. A relative folder is resolved from where you run the command. |
| `-V`, `--version` | Print the version. |

## devtool server

Runs the server, the interface and the load balancer.

```bash
devtool server
devtool server -g 7730 -l 7731
devtool server ./config.yml ./config.local.yml
```

| Argument or option | Default | Description |
|---|---|---|
| `[configurations...]` | `config.yml` and `config.local.yml` of the configuration folder | Configuration files to load instead, in order. The last one ending in `.local.yml` is the personal file. |
| `-s`, `--ssl <domain>` | none | Serve the interface on this host through the load balancer (sets `adt.host`). |
| `-g`, `--server-port <port>` | `adt.ports.server`, `6730` | Port of the server and the interface. |
| `-l`, `--load-balancer-port <port>` | `adt.ports.loadBalancer`, `6731` | Port of the load balancer. |
| `--dns-port <port>` | `dns.port`, `53` | Port of the [DNS](/configuration/network#the-local-dns), for this run. |
| `--log-level <level>` | `info` | `error`, `warn`, `info` or `debug`. |

On macOS, the server runs again under an application named after `adt.displayName`, so system prompts
(1Password, notifications) show that name.

## devtool proxy

Forwards a privileged port, such as 443, to the load balancer, so your services answer on
`https://web.example.dev` without a port.

```bash
sudo devtool proxy
```

| Option | Default | Description |
|---|---|---|
| `-l`, `--load-balancer-port <port>` | `6731` | Port of the load balancer. |
| `-p`, `--proxy-port <port>` | `443` | Port the proxy listens on. |
| `--log-level <level>` | `info` | `error`, `warn`, `info` or `debug`. |

## devtool login and logout

```bash
devtool login
devtool logout
```

`login` signs in with the [identity provider](/configuration/auth) of the configuration, in your browser:
it needs an `auth` section. `logout` forgets the session of the identity provider.

## devtool env

Synchronizes the [environment](/configuration/environment/) with its [backends](/configuration/environment/backends).
It needs at least one backend in `environment.backends`.

```bash
devtool env pull --yes
devtool env pull api/db.gz:public.user,public.session
devtool env push -i
```

| Command | Options | Description |
|---|---|---|
| `env pull [targets...]` | `-i`, `--interactive`: choose items, tables and key groups. `-y`, `--yes`: replace local data without asking. | Replace the local items, and the data they hold, by the copies of their backends. |
| `env push [targets...]` | `-i`, `--interactive` | Dump the local data of the items and send them to their backends. Needs write rights. |

A target is a path (`api/config.yml`), tables of a database (`api/db.gz:public.user,public.session`) or
key groups of a Redis database (`api/redis.gz:session:*`). Without target, every item is synchronized.

When the configuration declares no item yet, `devtool env` first downloads the shared
`devtool/config.yml` from the default backend. A file [encrypted](/configuration/environment/encryption) with
`prompt: true` has its password asked in the terminal; without a terminal, the command stops.

## devtool env file

Reads and changes any file of a backend directly, outside the items of the environment.

```bash
devtool env file pull api/config.yml ./config.yml
devtool env file pull api/config.yml -
devtool env file push api/config.yml ./config.yml
devtool env file push api/dump.bin ./dump.bin -t application/octet-stream -b archive
devtool env file rm api/old.yml -b archive
```

| Command | Description |
|---|---|
| `env file pull <path> [destination]` | Download a file, to the file name of `path` by default; `-` writes it to the standard output. |
| `env file push <path> <file> [-t <mediaType>]` | Upload a file, replacing the stored one. The media type is guessed from the name unless `-t` gives it. Needs write rights. |
| `env file rm <path>` | Delete a file. Needs write rights. |

Every one takes `-b, --backend <name>`, a backend of `environment.backends`, the default one when
omitted. The files come decrypted by the encryption of the backend, but not by that of an item.

## devtool cert renew

```bash
devtool cert renew
devtool cert renew example.dev
```

Renews now the [certificates](/configuration/certificates) declaring `acme`, every one without name, and
writes them where they are served. It reads the default configuration files.

## devtool skills sync

```bash
devtool skills sync
devtool skills sync --target ~/.agents/skills ~/.claude/skills --link
```

Installs or updates the [agent skills](/agents/skills) of the devtool in the skill folders of your
agents. Without `--target`, it asks for the folders, the mode and whether to replace a skill of your own
with the same name; without a terminal, `--target` is required.

| Option | Meaning |
|---|---|
| `-t, --target <folders...>` | Skill folders to sync, asked when omitted. |
| `--copy` | Copy the skills (the default without a terminal). |
| `--link` | Link the skills to this installation of the devtool. |

Skills it installed earlier and the devtool no longer ships are removed; your own skills are never
touched without your agreement.

## Environment variables

Read by the devtool:

| Variable | Description |
|---|---|
| `ADT_CONFIG_FOLDER` | Configuration folder when `--config-folder` is not given. |
| `DEVTOOL_UI_PATH` | Development only: where the server proxies the interface, `http://127.0.0.1:6731` by default. |
| `SHELL` | Shell of the commands when neither the command, the project nor `adt.shell` sets one. |
| `INIT_CWD` | Folder relative paths are resolved from when the CLI runs through a package manager. |

Any `$VAR` or `${VAR}` in the configuration is also replaced by its value when the file is loaded.

Given to every command the devtool runs:

| Variable | Value |
|---|---|
| `APPSYS_DEVTOOL` | `true` |
| `APPSYS_DEVTOOL_CACHE_DIR` | `adt.cacheDir`, so a docker-compose can keep its data there |
| `FORCE_COLOR` | `3` |
| `TERM` | `xterm-256color` |
