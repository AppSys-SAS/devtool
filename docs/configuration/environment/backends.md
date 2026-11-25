---
description: Choose where the files of the environment are stored, a CDN, an S3 bucket, an SFTP server, a git repository or your own scripts, and which item goes where.
---

# Backends

The [environment](/configuration/environment/) lives in a folder on your machine, and a **backend** is
where the team keeps its copy of that folder. Teams already store files somewhere: a bucket, a file
server, a repository, a drive. Rather than asking you to run one more server, the devtool talks to
the storage you have, and each item of the environment can live in a different one: the small
configuration files on a CDN, the large database archives in a bucket.

```yaml [config.yml]
auth:
  issuer: https://auth.example.dev
  clientId: devtool
environment:
  backends:
    team:
      type: cdn
      url: https://files.example.dev
      default: true
    archive:
      type: s3
      bucket: acme-dev-environment
  files:
    - devtool/config.yml
    - api/config.yml
  databases:
    - { path: api/db.gz, engine: postgres, container: postgres, backend: archive }
```

Here `devtool/config.yml` and `api/config.yml` go to the `team` CDN, the default backend, and the
database archive goes to the `archive` bucket.

| Type | Stores the files | Signs in with |
|---|---|---|
| [`cdn`](/configuration/environment/cdn) | on a server of the devtool files API | your [sign-in](/configuration/auth) |
| [`s3`](/configuration/environment/s3) | in a bucket of AWS or of any S3 compatible service | access keys, or the AWS credentials of your machine |
| [`sftp`](/configuration/environment/sftp) | in a folder of an SFTP server | a private key, a password or your SSH agent |
| [`git`](/configuration/environment/git) | in a git repository, one commit per push | the credentials of your git |
| [`scripts`](/configuration/environment/scripts) | anywhere your own commands reach | whatever your commands use |

Every backend can also [encrypt](/configuration/environment/encryption) everything it stores.

## The default backend

`environment.backends` is a map of backends by name. An item naming no backend uses the default one:
the backend marked `default: true`, else the first one declared. When several are marked, the first
of them wins and the devtool warns.

The default backend also serves the shared configuration, `devtool/config.yml`. When your
configuration declares no item yet, as on the first day of a new developer, `devtool env pull`
downloads `devtool/config.yml` from the default backend first, then pulls what it declares.

::: tip Where to declare the backends
A new developer has no shared configuration yet, so the default backend, and the `auth` section a
`cdn` backend needs, go in their personal `config.local.yml`:

```yaml [config.local.yml]
auth:
  issuer: https://auth.example.dev
  clientId: devtool
environment:
  backends:
    team: { type: cdn, url: "https://files.example.dev", default: true }
```

The other backends can be declared in the shared `config.yml`, which reaches everyone with the first
pull.
:::

## Choose the backend of an item

Files, databases, buckets and Redis databases all take `backend`, the name of a backend:

```yaml [config.yml]
environment:
  backends:
    team: { type: cdn, url: "https://files.example.dev" }
    nas: { type: sftp, host: nas.example.dev, username: dev }
  files:
    - devtool/config.yml
    - { path: api/config.yml, backend: nas }
  buckets:
    - { path: api/s3.gz, bucket: uploads, backend: nas }
  s3: { endpoint: "http://localhost:9000", accessKeyId: minioadmin, secretAccessKey: minioadmin }
```

A backend that is not declared stops the environment: `api/config.yml: backend "nas" is not declared
in environment.backends`.

::: warning Moving an item to another backend
The devtool remembers which backend each item was last synchronized with. After you change the
`backend` of an item, it counts as never synchronized: push it once to its new backend, the old copy
stays where it was.
:::

## Migrate from the `cdn` section

::: warning The top-level `cdn` section is gone
Before backends, the CDN was a section of its own:

```yaml [before]
cdn:
  url: https://files.example.dev
```

It now is a backend like the others:

```yaml [config.local.yml]
environment:
  backends:
    team: { type: cdn, url: "https://files.example.dev" }
```

The devtool ignores the old section and warns `cdn: is replaced by a backend of the environment:
environment.backends.<name> { type: cdn, url }`. Any name works; it is the one items give in
`backend`.
:::

## Read and write a file by hand

`devtool env file` reads and changes any file of a backend, the default one unless you name another
with `-b`:

```bash
devtool env file pull api/config.yml ./config.yml
devtool env file pull api/config.yml - | less
devtool env file push api/config.yml ./config.yml -b nas
devtool env file rm api/old.yml -b nas
```

The files come as the backend keeps them, decrypted by the [encryption](/configuration/environment/encryption) of
the backend but not by that of an item. The [CLI reference](/reference/cli#devtool-env-file) lists the
options.

## Reference

### environment.backends.&lt;name&gt;

Every backend takes these keys, on top of those of its type:

| Key | Type | Default | Description |
|---|---|---|---|
| `type` | `cdn`, `s3`, `sftp`, `git`, `scripts` | required | Kind of backend. |
| `default` | boolean | `false` | Items naming no backend, and the shared configuration, use this one. The first backend when none is marked. |
| `encryption` | map | none | Encrypt every file stored here: `{ key }`, `{ password }` or `{ prompt: true }`. See [Encryption](/configuration/environment/encryption). |

The keys of each type are listed on its page: [cdn](/configuration/environment/cdn),
[s3](/configuration/environment/s3), [sftp](/configuration/environment/sftp),
[git](/configuration/environment/git), [scripts](/configuration/environment/scripts).

### Items

| Key | Type | Default | Description |
|---|---|---|---|
| `environment.<list>[].backend` | string | the default backend | Name of the backend storing the item. |

### Warnings

The Server page lists these problems. Except for the last three, each one also stops the environment
(see [Errors](#errors)).

- `environment.backends: must be a map of backends by name`
- `environment.backends.<name>.type: must be one of cdn, s3, sftp, git, scripts`
- `environment.backends.<name>.default: must be true or false`
- `environment.backends.<name>.encryption: must be { key } (32 bytes in base64), { password } or { prompt: true }`
- the warnings of each type, listed on its page: [cdn](/configuration/environment/cdn#warnings-and-errors),
  [s3](/configuration/environment/s3#warnings), [sftp](/configuration/environment/sftp#warnings),
  [git](/configuration/environment/git#warnings), [scripts](/configuration/environment/scripts#warnings)
- `environment.backends: several backends are the default one, <name> is used`
- `environment.backends.<name>: a cdn backend needs an auth section, signing the developers in`
- `cdn: is replaced by a backend of the environment: environment.backends.<name> { type: cdn, url }`

### Errors

These stop the environment: the Environment page shows them and `devtool env` exits.

- `invalid backend in the environment: <setting> <message>`: one of the [warnings](#warnings) above,
  except the last three.
- `<path>: backend "<name>" is not declared in environment.backends`
- `no backend in environment.backends: declare one in config.local.yml, such as { team: { type: cdn, url } }`:
  `devtool env` has nowhere to pull from.
