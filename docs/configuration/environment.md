---
description: Share configuration files, database copies, buckets and Redis data with your team through the backends of the environment.
---

# Environment

The environment is everything a project needs locally besides its code: configuration files, a copy of
its database, the files of its bucket, its Redis data. The devtool keeps it in one folder on your machine
and mirrors that folder on one or more [backends](/configuration/backends): a CDN, a bucket, an SFTP
server, a git repository or your own scripts. A new developer gets a working setup with one command,
and anyone can share a fresh database copy with a push.

```yaml [config.yml]
environment:
  backends:
    team: { type: s3, bucket: acme-dev-environment }
  files: [ devtool/config.yml, api/config.yml ]
  databases:
    - { path: api/db.gz, engine: postgres, container: postgres }
```

Then, on any machine of the team:

```bash
devtool env pull --yes
```

## The environment folder

`environment.folder` is the local mirror, by default the parent of the configuration folder
(`~/.config/appsys`). A path `<path>` on a backend is `<environment folder>/<path>` on your machine. A
typical folder looks like this:

| Path | Content |
|---|---|
| `devtool/config.yml` | the shared devtool configuration |
| `devtool/docker-compose.yml` | containers of the environment (databases, mail, S3), run by a project of the configuration |
| `api/config.yml` | full configuration of an application |
| `api/db.gz` | archive of a local database: schema, then the rows of each table |
| `api/s3.gz` | snapshot of a local bucket, media types kept |
| `devtool/session.json`, `devtool/config.local.yml` | personal, never synchronized |

Only what `environment` declares is synchronized, the shared configuration itself included: list
`devtool/config.yml` in `files` to share it.

## Where the files go

Each item is stored by a backend: the one its `backend` names, else the default backend. Each item can
also be encrypted on your machine before it leaves it, with its own `encryption` or with the rules of
`environment.encryption`:

```yaml [config.yml]
environment:
  backends:
    team: { type: cdn, url: "https://files.example.dev", default: true }
    archive: { type: s3, bucket: acme-dev-environment }
  encryption:
    - { paths: [ "**/.env" ], prompt: true }
  files:
    - devtool/config.yml
    - web/.env
  databases:
    - { path: api/db.gz, engine: postgres, container: postgres, backend: archive }
```

[Backends](/configuration/backends) describes each kind of storage and how to choose one, and
[Encryption](/configuration/encryption) the secrets and the rules.

## Files

A file is a path, or a map when you need more:

```yaml [config.yml]
environment:
  files:
    - devtool/config.yml
    - { path: api/config.yml, local: false }
    - { path: devtool/docker-compose.yml, display: false }
    - { path: web/.env, sync: false }
```

- `display: false` keeps it out of the Configs page.
- `local: false` lists it without its personal `.local.yml` override.
- `sync: false` lists it but never synchronizes it with its backend.

::: tip Personal overrides
The Configs page lets you write a `.local.yml` next to a YAML file of the environment (`api/config.local.yml`
for `api/config.yml`). It stays on your machine, so you can change a value without touching the shared copy.
:::

### Ignored keys

Some tools write values of their own into a shared file: the last time a connection was used, a window
size. `ignore` leaves these keys out of the synchronization of a YAML, JSON or `.env` file:

```yaml [config.yml]
environment:
  files:
    - { path: db-studio/connections.json, ignore: [ connections.*.lastUsedAt ] }
```

- A key is a dotted path. `*` stands for one key or one list index, `**` for any depth
  (`**.updatedAt`).
- Two copies that differ only by ignored keys are up to date: neither the Environment page nor the
  agents show a change.
- A pull keeps your values of the ignored keys, and a push keeps the ones of the backend. A new entry of a
  list arrives with its own values.

## Databases

```yaml [config.yml]
environment:
  databases:
    - { path: api/db.gz, engine: postgres, container: postgres }
    - { path: shop/db.gz, engine: mariadb, container: mariadb }
    - { path: events/db.gz, engine: mongodb, container: mongo }
```

The devtool dumps and restores a database inside its Docker container (`docker exec`), with the
credentials found in the environment of that container. Foreign keys are not checked while rows are
loaded, so tables can come back in any order.

- `postgres` and `mariadb`: the official images.
- `mongodb`: its collections are its tables. The database is `MONGO_INITDB_DATABASE`, and the root
  credentials `MONGO_INITDB_ROOT_USERNAME` and `MONGO_INITDB_ROOT_PASSWORD` are used when set.

A pull drops and recreates the database. A push dumps it, then sends the archive.

## Buckets and S3

```yaml [config.yml]
environment:
  buckets:
    - { path: api/s3.gz, bucket: uploads }
  s3: { endpoint: "http://localhost:9000", accessKeyId: minioadmin, secretAccessKey: minioadmin }
```

A bucket is saved as a snapshot, media types kept, and emptied before a pull restores it. `s3` tells
where your local S3 server is; `region` defaults to `us-east-1`.

## Redis

```yaml [config.yml]
environment:
  redis:
    - { path: api/redis.gz, url: "redis://localhost:6379/0" }
```

`url` names the server and the database number. You can pull or push a group of keys only, such as
`api/redis.gz:session:*`.

## Pull on a schedule

Any item can be pulled on its own while the server runs, with `pull`:

```yaml [config.yml]
environment:
  files:
    - { path: api/config.yml, pull: { startup: true } }
  databases:
    - { path: api/db.gz, engine: postgres, container: postgres, pull: { cron: "0 8 * * 1-5" } }
```

- `cron`: a cron expression, here every weekday at 8:00.
- `startup: true`: when the server starts.

To keep your work safe, a scheduled pull skips an item in two cases, and reports it on the Environment
page:

- its copy on its backend did not change since the last sync (nothing to do);
- its local copy changed since the last sync, or was never synchronized.

::: warning
For a database, a bucket or Redis, only the local archive is compared. Data you changed in the database
itself is replaced by the pull.
:::

## Pull and push by hand

```bash
devtool env pull                          # everything
devtool env pull api/config.yml api/db.gz # some items
devtool env pull api/db.gz:public.user,public.session
devtool env push -i                       # choose items and tables
```

- `devtool env pull [targets...]` replaces the local copies by those of their backends, then restores
  the databases, buckets and Redis data they hold. It asks before replacing local data, unless you pass
  `--yes`.
- `devtool env push [targets...]` dumps the local databases, buckets and Redis data, then sends the local
  copies to their backends. You need write rights on them.
- A target is a path, tables of a database (`api/db.gz:public.user,public.session`) or key groups of a
  Redis database (`api/redis.gz:session:*`). A table is emptied and reloaded on pull; its rows are
  replaced in the stored archive on push. Without target, the whole environment is synchronized.
- `-i` chooses items, tables and key groups interactively.

The Environment page shows the same actions, with the state of each item, its backend and whether it is
encrypted. `devtool server` never
downloads anything on its own: pulls are manual, or scheduled with `pull`. When the devtool configuration
itself is missing, the Environment page offers to pull it.

When a file is [encrypted](/configuration/encryption) with `prompt: true`, `devtool env` asks its password
in the terminal, and the server in a dialog of the interface.

To read or change a single file of a backend, outside the items, use
[`devtool env file`](/reference/cli#devtool-env-file).

## First start of a developer

1. Write `config.local.yml` in `~/.config/appsys/devtool` with your `workspace` and the default
   [backend](/configuration/backends) of the team in `environment.backends`, plus the
   [`auth`](/configuration/auth) section of your identity provider when that backend is a
   [CDN](/configuration/cdn).
2. `devtool login`, to sign in with the identity provider, when there is one
3. `devtool env pull --yes`: it downloads the shared `devtool/config.yml` from the default backend
   first, then everything it declares
4. `devtool server`

## Reference

### environment

| Key | Type | Default | Description |
|---|---|---|---|
| `backends` | map | none | Where the files are stored, by name. See [Backends](/configuration/backends). |
| `encryption` | list | none | Encryption rules by path pattern. See [Encryption](/configuration/encryption). |
| `folder` | string | parent of the configuration folder | Local mirror of the files of the backends, relative to the configuration folder. |
| `files` | list | none | Files synchronized and shown in Configs. |
| `databases` | list | none | Databases saved as archives. |
| `buckets` | list | none | S3 buckets saved as snapshots. |
| `redis` | list | none | Redis databases saved as dumps. |
| `s3` | map | none | The S3 server of the buckets. |
| `mcp` | [rules](/configuration/mcp) | `adt.mcp.default` | What agents may do with the environment. |

### environment.files[]

A path, or:

| Key | Type | Default | Description |
|---|---|---|---|
| `path` | string | required | Path in the environment folder. |
| `display` | boolean | `true` | List it in the Configs page. |
| `local` | boolean | `true` | Offer a personal `.local.yml` override. |
| `sync` | boolean | `true` | Synchronize it with its backend. |
| `backend` | string | the default backend | Name of the backend storing it. |
| `encryption` | map | `environment.encryption` | `{ key }`, `{ password }` or `{ prompt: true }`. |
| `ignore` | list | none | [Keys](#ignored-keys) left out of the synchronization, each copy keeping its values. |
| `pull` | map | none | Scheduled pull. |
| `mcp` | rules | `environment.mcp` | Agent permissions; `keys` allowed. |

### environment.databases[]

| Key | Type | Default | Description |
|---|---|---|---|
| `path` | string | required | Archive in the environment folder. |
| `engine` | `postgres`, `mariadb`, `mongodb` | required | Database engine. |
| `container` | string | required | Docker container running it. |
| `backend` | string | the default backend | Name of the backend storing it. |
| `encryption` | map | `environment.encryption` | `{ key }`, `{ password }` or `{ prompt: true }`. |
| `pull` | map | none | Scheduled pull. |
| `mcp` | rules | `environment.mcp` | Agent permissions. |

### environment.buckets[]

| Key | Type | Default | Description |
|---|---|---|---|
| `path` | string | required | Snapshot in the environment folder. |
| `bucket` | string | required | Name of the bucket. |
| `backend` | string | the default backend | Name of the backend storing it. |
| `encryption` | map | `environment.encryption` | `{ key }`, `{ password }` or `{ prompt: true }`. |
| `pull` | map | none | Scheduled pull. |
| `mcp` | rules | `environment.mcp` | Agent permissions. |

### environment.redis[]

| Key | Type | Default | Description |
|---|---|---|---|
| `path` | string | required | Dump in the environment folder. |
| `url` | string | required | `redis://host:port/<db>`. |
| `backend` | string | the default backend | Name of the backend storing it. |
| `encryption` | map | `environment.encryption` | `{ key }`, `{ password }` or `{ prompt: true }`. |
| `pull` | map | none | Scheduled pull. |
| `mcp` | rules | `environment.mcp` | Agent permissions. |

### environment.s3

| Key | Type | Default | Description |
|---|---|---|---|
| `endpoint` | string | required | URL of the S3 server. |
| `accessKeyId` | string | required | Access key. |
| `secretAccessKey` | string | required | Secret key. |
| `region` | string | `us-east-1` | Region. |

### pull

| Key | Type | Default | Description |
|---|---|---|---|
| `cron` | string | none | Cron expression of the scheduled pull. |
| `startup` | boolean | `false` | Pull when the server starts. |

### Errors

Unlike the other settings, a mistake here is not a warning: the whole environment becomes invalid, the
Environment page shows the error and `devtool env` stops.

- `invalid file in the environment: <item>`, `invalid database in the environment: <item>`: a key has the
  wrong type, or a required one is missing. Only `files` accepts the short form of a plain path.
- `invalid pull of <path> in the environment: <value>`, `<path>: invalid pull cron "<cron>"`
- "the environment declares buckets without `s3` server": `s3` is missing, or lacks `endpoint`,
  `accessKeyId` or `secretAccessKey`.
- `invalid backend in the environment: ...`, `<path>: backend "<name>" is not declared in
  environment.backends`: see [Backends](/configuration/backends#errors).
- `invalid encryption rule in the environment: ...`, `invalid encryption of <path> in the environment:
  ...`: see [Encryption](/configuration/encryption#warnings-and-errors).
- `invalid ignore of <path> in the environment: must be a list of key paths, such as
  connections.*.lastUsedAt`, `... needs a YAML, JSON or .env file`: see [Ignored keys](#ignored-keys).
