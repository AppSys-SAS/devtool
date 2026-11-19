# Devtool

Web-based devtool, built with:

- `pnpm` workspace monorepo (`apps/*`, `packages/*`)
- TypeScript everywhere
- Vue + Vite + Tailwind v4 via `@tailwindcss/vite`
- `shadcn-vue` (reka base, default theme)
- Real PTY terminal using `xterm` + `node-pty`

## Workspace

- `apps/cli`: CLI entrypoint (`devtool`)
- `apps/server`: WS/API server + command streams + load balancer
- `apps/proxy`: TCP proxy helper
- `apps/ui`: web frontend
- `packages/config`: YAML config loading/merging
- `packages/cdn`: OpenID Connect sign-in and devtool files of the CDN (Node library, no CLI dependency)
- `packages/mcp`: MCP server for agents (tools, approvals, history), plugged into the server through the
  interfaces it declares (`McpServerHost`)
- `packages/shared`: shared types/logger

## Config Resolution

Nothing is read from the devtool installation. The configuration folder is `--config-folder <folder>`
(any command), else `$ADT_CONFIG_FOLDER`, else `~/.config/appsys/devtool`; it holds, each overriding the
previous one:

1. `config.yml`: shared configuration (`adt`, `loadBalancers`, `cdn`, `sections`, `projects`,
   `environment`), mirrored on the CDN
2. `config.local.yml`: personal overrides, never synchronized

It also keeps the CDN session (`session.json`) and the synchronization journal (`sync.json`).

- Relative paths (`adt.cacheDir`, `adt.icon`, certificates, `environment.folder`, `workspace`) are
  resolved from the configuration folder.
- The interface is never configured there: `devtool server` serves the UI built with it, `pnpm dev`
  proxies Vite (`$DEVTOOL_UI_PATH`, else `http://127.0.0.1:6731`).
- Relative section paths are resolved from `workspace`, the personal folder holding the repositories
  (`workspace: ~/Workspace` in `config.local.yml`); without it they are ignored with a warning.
- `sectionPath` (default `.`, the workspace itself) is the path of the sections declaring none, for
  instance those of a configuration kept in a repository and brought by `include`:

  ```yaml
  workspace: ~/Workspace
  sectionPath: acme/monorepo
  include: [ ~/Workspace/acme/monorepo/.devtool/*.yml ]
  ```
- `environment.folder` is the local mirror of the CDN files, the parent of the configuration folder by
  default; the shared configuration is its `devtool/config.yml`.

`adt.cacheDir` (`~/.cache/appsys/devtool` by default) holds what the devtool rebuilds or keeps between
runs (the macOS app below); every command it runs receives it as `APPSYS_DEVTOOL_CACHE_DIR`, so a
docker-compose of the environment can keep its data there.

The devtool names and shows itself from three settings:

```yaml
adt:
  displayName: AppSys Devtool   # the macOS app, the tab, the sidebar, the notifications
  name: appsys-devtool          # the MCP server for agents, the identifier of the macOS app; the display name in lowercase by default
  icon: assets/icon.svg         # SVG, PNG, JPEG or ICNS: the favicon, the notifications, the macOS app
```

A new developer writes `config.local.yml` with `workspace` and `cdn`, then runs `devtool env pull`.

## Missing folders

A section or a project whose folder is missing shows greyed in the sidebar when it declares `restore`, a
command run in the parent folder, `%{ADT:PATH}` standing for the missing folder; the configuration is
reloaded once it ends. A folder of files names one of its commands instead:

```yaml
sections:
  api:
    path: api
    restore: { name: Clone, args: [ git, clone, git@github.com:example/api.git, "%{ADT:PATH}" ] }
projects:
  desktop:
    section: api
    path: ../desktop
    restore: { name: Clone, args: [ git, clone, git@github.com:example/desktop.git, "%{ADT:PATH}" ] }
  secrets:
    files:
      secrets: { path: ~/secrets, restore: secrets-pull }
```

## Services

The `services` of a project are the hosts the load balancer serves for it:

- `host`, or `hosts` for several: the names served.
- `target`: where requests go, a port of this machine (`5173`), `<host>:<port>` (`192.168.1.20:8080`,
  `[::1]:8080`, plain HTTP) or an http(s) URL (`https://192.168.1.20:8443/base`); a list shares the
  requests in turn.
- `tls`: requests forwarded as HTTPS (`x-forwarded-proto`, `-port`, `-ssl`), whatever the target uses.
- `path`, `pathNot`, `prefix`, `preserveHost`, `access`.

```yaml
projects:
  web:
    services:
      web: { host: web.example.dev, target: 5173, tls: true, access: network }
```

## Section start and stop

The header of a section in the sidebar stops every running command of the section, and starts the
commands declaring `startWithSection: true`, those not running yet; the command a project runs by
`default` starts as its main command.

```yaml
projects:
  web:
    default: { action: command:dev }
    commands:
      dev: { name: Vite dev, args: [ pnpm, dev ], startWithSection: true }
```

## Scripts and inputs

`scripts` lists folders whose executables become commands of the project, their slug being their
path from the project (`scripts/deploy.sh`), listed again when a file is added or removed:
`{ path, prompt, only, scripts }`, `only` keeping the file names matching its glob patterns, `scripts`
setting `prompt` and `args` per file name. The comment heading a script (`#` lines after the shebang)
describes it, its `Usage:` line and the indented lines that follow shown with it.

An entry of `args`, of a command or of a script (after its path), is a value or an input asked when
the command starts, replaced by what is typed:

- `{ name, choices, optional, display }`: one of the choices, required unless `optional`, picked
  from `buttons` (default) or a `dropdown`; a choice is a value, or `{ label, value }` to show a label;
- `{ name, flag: true }`: the name when ticked;
- `{ name, text: true }`: free text, split like a shell does.

Any input may give a `default` value: one of its choices, a boolean for a flag, a text. Clicking the
command asks for its inputs, their default values already filled in. Started on its own, as the
`default` of its project or with its section, it runs with its default values, and asks only when a
required choice has none. A script without `args` asks for free text, and value blocks are never read
in what is typed.

On the page of the project, `form` sets where a command asks for its inputs: `dialog` (default of a
command) or `inline`, in its row unfolded with its description (default of a script). A folder of
scripts gives the `form` of its scripts, each script its own. The sidebar always asks in a dialog.

```yaml
projects:
  e2e:
    commands:
      run-project:
        args: [ yarn, test:e2e, { name: project, choices: [ admin, { label: Shared files, value: shared-files } ], default: admin, display: dropdown }, { name: --headed, flag: true } ]
    scripts:
      - path: scripts
        scripts:
          deploy.sh: { prompt: true, args: [ { name: env, choices: [ prd, pre ] } ] }
```

## Sidebar

`adt.sidebar` shows the optional parts of the sidebar, all hidden by default: the links to the
`environment` and `configs` pages, and the CDN sign-in state, `login`. The pages stay reachable by
their address.

```yaml
adt:
  sidebar: { environment: true, configs: true, login: true }
```

## Integrations

External tools reachable over HTTP, declared at the root of the configuration (rows under Environment
and Configs) or by a project (listed in its side panel):

- `name`, `url` (http or https): required; `icon`: an Iconify name.
- `embed` (default `true`): shown in a frame of the devtool, the load balancer then letting the devtool
  host frame the host of `url` (`X-Frame-Options` removed, `frame-ancestors` set); `false` opens a new tab.

## Sidebar shortcuts

A project puts what it declares in its sidebar row with `icons` (icons at the right of the row) and
`lines` (rows under it), in the order of the list, each `<type>:<slug>`:

- `integration:<slug>`, `command:<slug>`, `files:<slug>`
- `service:<slug>[:<index>]`: opens the host at that index of the service (default `0`) in a new tab.

`default` is what the project does by default, with the same syntax; a command becomes its main
command (status of the row, stop and restart). `trigger` says how it runs:

- `icon` (default): from its button shown when hovering the row.
- `row`: on a click on the row, which then no longer opens the project; a main command already running
  opens the project as usual.
- `row-icon`: both.

Its button shows a play icon for a command, an open folder for files, a globe for a service and a
generic integration icon for an integration; `icon` replaces it with an Iconify name, or `own` for the
icon of the integration.

```yaml
integrations:
  mail: { name: Mailpit, icon: mdi:email, url: "https://mailpit.example.dev" }
projects:
  environment-docker:
    default: { action: command:up }
    commands:
      up: { name: Compose Up, args: [ docker, compose, up ] }
    integrations:
      redis-insight: { name: RedisInsight, icon: devicon:redis, url: "https://redisinsight.example.dev" }
    icons: [ integration:redis-insight, service:mailpit ]
    lines: [ command:logs, files:data ]
  secrets:
    default: { action: files:secrets, trigger: row }
    files:
      secrets: { path: ~/secrets }
```

## Network access

The load balancer listens on every interface of port 443 and serves HTTP/2, HTTP/1.1 for older clients
and WebSockets; the server and the UI listen on `127.0.0.1` only. Who reaches a host is decided by the address of the connection, never by a forwarded header:

- `adt.access` (interface of the devtool) and the `access` of each service: `local` (default, this
  machine only) or `network` (any client).
- `passthrough` (usually personal, in `config.local.yml`): TLS connections forwarded untouched by their
  server name, for the tools serving their own certificates.

```yaml
passthrough:
  - { hosts: [ example.dev, "*.example.dev" ], target: "127.0.0.1:8443", access: local }
```

The local DNS (port 53, UDP and TCP) answers the names of `dns.records` with an IPv4 address, `auto`
being the current network address of this machine, and resolves every other name through the system.
`records` is a map, so `config.local.yml` adds its own names.

```yaml
dns:
  access: network
  records:
    dev: { names: [ example.dev, "*.example.dev" ], address: auto }
```

## Certificates

`loadBalancers.<name>` serves the certificate `crt` with its key `key`, files or PEM texts. A certificate
whose `crt` and `key` are files may declare `acme` to be renewed; the Server page lists the certificates
with their expiry, and `devtool cert renew [names...]` renews them from a terminal.

```yaml
loadBalancers:
  example.dev:
    crt: certs/example.dev.crt
    key: certs/example.dev.key
    warn: 30                    # days before the expiry from which the Server page warns (default 30)
    acme:
      trigger: both             # button (default), auto or both
      before: 30                # days before the expiry from which auto renews (default 30)
      env: { INFOMANIAK_ACCESS_TOKEN: "{{ op://vault/infomaniak/token }}" }
      lego:
        domains: [ example.dev, "*.example.dev" ]
        email: certs@example.dev
        dns: infomaniak
```

- `lego` holds the options of `lego run` without their dashes: a value gives `--name value`, a list
  repeats the option, `true` gives it alone. The devtool sets `path` (its cache), `cert.name`,
  `accept-tos` and the renewal options itself. `env` gives lego and its DNS provider their variables.
- The devtool runs lego `5.6.0`, downloaded from the lego releases the first time a certificate is
  renewed with it, its checksum checked, for macOS and Linux on arm64 and x64; a newer devtool installs
  its own version and removes the others. Its account and certificates stay in the cache folder.
- `command` replaces `lego` for any other tool: `[ ./renew.sh, "%{ADT:CRT}", "%{ADT:KEY}" ]`, run in the
  folder of the certificate, writes the certificate and its key at those paths.
- `button` renews from the Server page, forced even when not due. `auto` renews when the server starts
  and twice a day once the certificate expires within `before` days, at most once a day. The load
  balancer serves the new certificate right away. When `crt` and `key` are synchronized files of the
  environment, the Server page then offers to push them to the CDN.
- The Server page warns from `warn` days before the expiry for a certificate renewed by its button or
  not renewed at all; for one renewed on its own, from `before` days, once its automatic renewal should
  have happened.
- Value blocks are read as in commands, with `opAccount`, `unless` and `answers`. `opAccount` accepts the
  sign-in address of the 1Password account, the same for a whole team.

## Command automation

A command of the configuration may run on its own:

- `unless`: a check run first in the same shell, its success skipping the command.
- `answers`: `{ match, value }` typed when the output since the previous answer matches `match`
  (a case-insensitive regular expression), each answer once, in the declared order.
- Value blocks in `args`, `env` and answer values, replaced by what they read, anywhere in the text:
  - `{{ op://<vault>/<item>/<field> }}`: `op read`, from the 1Password account `opAccount` when declared;
  - `{{ $(<command>) }}`: the standard output of a command run in the login shell of the command,
    trailing newlines removed, a failure stopping the command before it starts.

Blocks of `args` and `env` are read when the command starts, those of an answer when its question
shows. Every value read is masked in the output, and only blocks of the configuration are read.

1Password references are read in a terminal of their own, opened for one run of the command and
closed when it ends: 1Password asks once per run, never reusing an earlier authorization.

On macOS, `devtool server` and `pnpm dev` run the server again, detached, under an app named after
`adt.displayName` built in the cache folder (its executable a hard link to Node, its icon `adt.icon` or
the one of `apps/server/assets`), the started process only relaying its stop and ending with it.
1Password names the process heading the tree, so its prompts show that name for everything the server
runs, commands calling `op` themselves included.

```yaml
login:
  opAccount: ABCDEFGHIJ
  unless: [ my-cli, status ]
  args: [ my-cli, login, --user, "{{ op://vault/item/username }}" ]
  env: { TOKEN: "{{ $(security find-generic-password -w -s my-token) }}" }
  answers:
    - { match: "Enter password", value: "{{ op://vault/item/password }}" }
    - { match: OTP, value: "{{ op://vault/item/otp?attribute=otp }}" }
```

## Agents (MCP server)

With `adt.mcp.enabled: true`, the server answers MCP clients of this machine over Streamable HTTP at
`http://127.0.0.1:<adt.ports.server>/mcp` (never through the load balancer nor for web pages of other
hosts). Claude Code connects with
`claude mcp add --scope user --transport http appsys-devtool http://127.0.0.1:6730/mcp`; the Connection tab of
the Agents page and [the setup skill](skills/devtool-mcp-setup/SKILL.md#agent-configurations) give the
configuration of the other agents (Claude Desktop, Codex, Gemini CLI, opencode, Cursor, GitHub Copilot,
Windsurf, Zed, Cline, Qwen Code, Mistral Vibe, Junie, JetBrains AI Assistant, Warp), and the
[`skills`](skills/README.md) folder holds agent skills to install next to it.

Tools: `list_projects`, `list_commands`, `list_terminals`, `read_terminal` (plain text from a cursor, or
the screen), `wait_for_output`, `search_terminals`, `run_command`, `run_shell`, `send_input`,
`control_terminal`, `resize_terminal`, `resolve_port_conflict`, `port_owners`, `start_section`,
`stop_section`, `restore_folder`, `list_files`, `read_file`, `write_file`, `update_keys`, `change_files`,
`environment_status`, `environment_keys`, `environment_tables`, `environment_sync`, `pull_shared_config`,
`list_certificates`, `renew_certificate`, `reload_config`, `notify_user`; the terminals are also resources
an agent may subscribe to (`devtool://terminals`, `devtool://terminal/<slug>`).

A new client is accepted first, by `adt.mcp.clients` or by the user. Then each call follows the level of
its action on what it acts on: `read` (see), `run` (start), `input` (type), `control` (stop, restart,
resize, free a port, reload) and `write` (files). A level is `allow`, `ask` (a dialog in the interface,
notified when `adt.mcp.notifications` is on, refused after `adt.mcp.timeout` seconds or at once when no
interface is open), `keys` (files only: their keys with the type of each value, `update_keys` for writing)
or `deny` (`read: deny` hides it from the agent). `mcp` takes a level for every action, or levels by
action, inherited from the most general to the most precise:

- commands and restores: `adt.mcp.default` > `adt.mcp.commands` > section > project > command;
- scripts: `adt.mcp.default` > `adt.mcp.scripts` > section > project > folder of scripts > script;
- folders of files: `adt.mcp.default` > `adt.mcp.files` > section > project > folder of files;
- terminals a person opened without a command: `adt.mcp.default` > `adt.mcp.terminals` (the terminal of a
  command follows its command);
- certificates: `adt.mcp.default` > `adt.mcp.certificates` > `loadBalancers.<name>.mcp`;
- `port_owners` (read) and `reload_config` (control): `adt.mcp.default` > `adt.mcp.devtool`;
- the `configs` files and the `environment_*` tools: `adt.mcp.default` > `environment.mcp`.

A setting of a section or project prevails over the categories, being more precise. Typing into and
controlling the terminals an agent started itself follow `adt.mcp.ownTerminals`; `run_shell` follows
`adt.mcp.shell` only; `notify_user` is always allowed. A push to the CDN and the pull of the shared
configuration are always confirmed, and agents never write the devtool configuration.

```yaml
adt:
  mcp:
    enabled: true
    notifications: true
    timeout: 120
    default: { read: allow, run: ask, input: ask, control: ask, write: ask }
    commands: { run: allow }
    scripts: { run: ask }
    files: { read: keys }
    terminals: { input: ask }
    certificates: { run: ask }
    devtool: { control: ask }
    clients: { level: ask, allow: [ claude-code ], deny: [] }
    ownTerminals: allow
    shell: { level: ask, allow: [ "git status*", "pnpm test*" ], deny: [ "rm *" ] }
projects:
  web:
    mcp: { input: deny }
    commands:
      dev: { name: Dev server, args: [ pnpm, dev ], mcp: { run: allow, control: allow } }
    scripts:
      - { path: scripts, mcp: { run: ask }, scripts: { deploy.sh: { mcp: deny } } }
    files:
      settings: { path: config, mcp: { read: keys, write: keys } }
environment:
  mcp: { read: keys, run: ask }
```

A request is answered once, for the session of the agent or always. The Agents page (robot icon next to
the bookmark icon of the sidebar) lists the sessions and clients, the requests waiting, the history of
every call (allowed again from a row for the session or always), the grants (removed one by one or all)
and the effective level of every action with the setting it comes from. Its Edit mode changes these levels
(or removes one, Inherit); the changes wait until Done writes them all (Cancel drops them) to
`config.local.yml` (Personal, loaded last, so it prevails over every file and include) or to the file
declaring each setting (Shared: `config.yml` or the included file of a repository), keeping comments and
layout, then reloads the configuration once. The history (1000 calls), the
grants and the clients accepted always are kept in `adt.cacheDir` (`mcp-history.jsonl`,
`mcp-grants.json`, `mcp-clients.json`); a `deny` of the configuration prevails over any grant. A session
is closed 30 seconds after its agent lost its event stream (the agent stopped), or after 30 minutes
without request for an agent that keeps none; its agent starts a new one. A call the agent abandons, or
whose session closes, withdraws its request, shown as `Cancelled` in the history.

## Development environment

The environment folder (`environment.folder`, `~/.config/appsys` by default) is the development
environment of every project, mirrored on the devtool files of the CDN (`<path>` there is
`<environment folder>/<path>` here), for instance:

| Path | Content |
|---|---|
| `devtool/config.yml` | shared devtool configuration |
| `devtool/docker-compose.yml` | containers of the environment (databases, mail, S3), run from a project of the configuration whose `path` is this folder |
| `api/config.yml` | full configuration of an application (`CONFIG_PATH` of its commands) |
| `api/db.gz` | archive of a local database: schema, then the rows of each table |
| `api/s3.gz` | snapshot of a local bucket, media types kept |
| `devtool/session.json`, `devtool/config.local.yml` | personal, never synchronized |

The `environment` section of the shared configuration declares what is synchronized, nothing else,
the shared configuration itself included:

```yaml
environment:
  files: [ devtool/config.yml, api/config.yml, { path: devtool/docker-compose.yml, local: false } ]
  databases:
    - { path: api/db.gz, engine: postgres, container: postgres }
  buckets:
    - { path: api/s3.gz, bucket: uploads-dev }
  s3: { endpoint: http://localhost:9000, accessKeyId: minioadmin, secretAccessKey: minioadmin }
```

- A file is a path, or `{ path, display, local, sync }` (all `true` by default): `display: false` keeps it
  out of the Configs tab, `local: false` lists it there without its personal `.local.yml` override,
  `sync: false` never synchronizes it with the CDN.
- Any item (file, database, bucket, Redis database) may be pulled on its own with
  `pull: { cron: "<cron expression>", startup: true }`, while the server runs: on its schedule and when the
  server starts. An item whose CDN copy did not change since the last sync is left alone; one whose local
  copy changed since then, or was never synchronized, is skipped and reported on the Environment page.
  For a database, a bucket or a Redis database only its local archive is compared: data changed in the
  database itself is replaced by the pull.
- `devtool env pull [targets...]` replaces the local copies by the CDN ones, then restores the
  databases (dropped and recreated) and the buckets (emptied) they hold. It asks before replacing
  local data, unless `--yes` is given.
- `devtool env push [targets...]` dumps the local databases and buckets, then sends the local copies
  (with write rights on the CDN).
- A target is a path (`api/config.yml`, `api/db.gz`) or tables of a database
  (`api/db.gz:public.user,public.session`): a table is emptied and reloaded on pull, its rows are
  replaced in the stored archive on push. Without target, the whole environment is synchronized;
  with `-i`, items and tables are chosen interactively.
- Databases are dumped and restored inside their container (`docker exec`), with the credentials of
  its environment; foreign keys are not checked while rows are loaded. Engines: `postgres` and
  `mariadb` (official images), and `mongodb`, whose collections are its tables (official image:
  the database is `MONGO_INITDB_DATABASE`, the root credentials `MONGO_INITDB_ROOT_USERNAME` and
  `MONGO_INITDB_ROOT_PASSWORD` are used when set).
- `devtool server` starts on the local copies and downloads nothing: pulls are always manual, from
  the CLI or the Environment page (which offers to pull the devtool configuration when it is
  missing).

First start of a developer: `devtool login`, `devtool env pull --yes`, then `devtool server`.

## CDN files

The CDN keeps the files the developers share under `<url>/devtool/`. Every call carries an access
token of an OpenID Connect issuer; the CDN decides from it who downloads, uploads and deletes.

```yaml
cdn:
  url: https://cdn.example.dev
  openid:
    issuer: https://auth.example.dev
    name: My SSO # shown in the sign-in texts, optional
    clientId: devtool
    callbackPort: 6732 # local address the issuer redirects to: http://127.0.0.1:6732/callback
```

- `devtool login` opens the issuer in the browser (authorization code with PKCE, public client) and
  keeps the tokens in `~/.config/appsys/devtool/session.json` (mode 600). The access token is renewed
  with the refresh token, one devtool process at a time. `devtool server` signs in first when no
  session exists. `devtool logout` forgets the session.
- `devtool cdn pull <path> [destination]` downloads a file (`-` writes it to the standard output).
  It refuses an incomplete download and writes the destination only once the file is whole.
- `devtool cdn push <path> <file> [-t <media type>]` and `devtool cdn rm <path>` change the files
  (with write rights on the CDN).

## Commands

```bash
pnpm install
pnpm -r build

# Run built server + UI dist
pnpm --filter @appsys/devtool-cli dev server

# Frontend-only dev mode
pnpm --filter @appsys/devtool-ui dev

# Server-only dev mode
pnpm --filter @appsys/devtool-server dev
```
