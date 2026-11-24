---
description: Choose where the files of the environment are stored, a CDN, an S3 bucket, an SFTP server, a git repository or your own scripts, and which item goes where.
---

# Backends

The [environment](/configuration/environment) lives in a folder on your machine, and a **backend** is
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
| [`cdn`](#cdn) | on a server of the devtool files API | your [sign-in](/configuration/auth) |
| [`s3`](#s3) | in a bucket of AWS or of any S3 compatible service | access keys, or the AWS credentials of your machine |
| [`sftp`](#sftp) | in a folder of an SFTP server | a private key, a password or your SSH agent |
| [`git`](#git) | in a git repository, one commit per push | the credentials of your git |
| [`scripts`](#scripts) | anywhere your own commands reach | whatever your commands use |

Every backend can also [encrypt](/configuration/encryption) everything it stores.

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

## cdn

A server of the devtool files API, reached with the access token of your
[sign-in](/configuration/auth). The server decides from your token, usually from your groups, who
may download, upload and delete. It needs the `auth` section.

```yaml [config.yml]
auth:
  issuer: https://auth.example.dev
  clientId: devtool
environment:
  backends:
    team:
      type: cdn
      url: https://files.example.dev
```

The files live under `<url>/devtool/`. The [CDN](/configuration/cdn) page describes the API and an
example server you can run yourself.

| Key | Type | Default | Description |
|---|---|---|---|
| `url` | string | required | Base address of the CDN, `http` or `https`. A trailing `/` is removed. |

## s3

A bucket of AWS, or of any S3 compatible service (MinIO, Garage, Ceph, Cloudflare R2, Scaleway,
OVHcloud...). The files are stored as objects under `prefix`.

On AWS, with the credentials of your machine:

```yaml [config.yml]
environment:
  backends:
    archive:
      type: s3
      bucket: acme-dev-environment
      region: eu-west-3
      prefix: environment
```

Without `accessKeyId`, the devtool uses the default AWS credentials of your machine, as the AWS CLI
does: the `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` variables, the profile of `AWS_PROFILE` in
`~/.aws`, an SSO session...

On an S3 compatible service, with keys read from your password manager:

```yaml [config.yml]
environment:
  backends:
    archive:
      type: s3
      bucket: dev-environment
      endpoint: https://s3.example.dev
      pathStyle: true
      accessKeyId: "{{ op://dev/s3/access-key }}"
      secretAccessKey: "{{ op://dev/s3/secret-key }}"
```

`accessKeyId` and `secretAccessKey` read [value blocks](/configuration/automation#value-blocks-read-secrets-at-the-last-moment),
so the keys never need to be written in a file. Most self-hosted services, MinIO among them, expect
`pathStyle: true`.

| Key | Type | Default | Description |
|---|---|---|---|
| `bucket` | string | required | Name of the bucket. |
| `prefix` | string | none | Folder of the files in the bucket, such as `environment`. |
| `endpoint` | string | AWS | Address of an S3 compatible service. |
| `region` | string | `us-east-1` | Region of the bucket. |
| `accessKeyId` | string | AWS credentials of the machine | Access key; value blocks are read. Needs `secretAccessKey`. |
| `secretAccessKey` | string | AWS credentials of the machine | Secret key; value blocks are read. Needs `accessKeyId`. |
| `pathStyle` | boolean | `false` | Address the bucket in the path (`https://s3.example.dev/<bucket>`) rather than in the host name. |

## sftp

A folder of an SFTP server: a NAS, a shared server of the team, any machine you reach with SSH.

```yaml [config.yml]
environment:
  backends:
    nas:
      type: sftp
      host: nas.example.dev
      username: dev
      path: /srv/dev-environment
```

The devtool signs in with the first of these it finds:

1. `privateKey`, a private key file (`~/.ssh/id_ed25519`), with its `passphrase` when it has one;
2. `password`;
3. your SSH agent, through `SSH_AUTH_SOCK`.

Without any of them, it stops with `cannot sign in to nas.example.dev: set privateKey or password on
the sftp backend, or start an SSH agent`. `passphrase` and `password` read value blocks.

An upload is written next to its place as `<file>.part`, then renamed, so a cut upload never replaces
the stored file; the folders are created as needed. The connection is opened on first use, and
opened again when it drops.

::: warning
A file counts as changed when its modification time or its size changes. Most servers keep the time
to the second, so two uploads of a file of the same size within the same second look like one.
The host key of the server is not checked: reach it through a network you trust.
:::

| Key | Type | Default | Description |
|---|---|---|---|
| `host` | string | required | Host name of the server. |
| `port` | integer | `22` | SSH port. |
| `username` | string | required | User on the server. |
| `path` | string | `.` | Folder of the files, relative to the home folder of the user when not absolute. |
| `privateKey` | string | none | Private key file; `~/` is your home folder. |
| `passphrase` | string | none | Passphrase of the private key; value blocks are read. |
| `password` | string | none | Password of the user; value blocks are read. |

## git

A git repository, for teams that want every change of the environment in a history they can read
and revert.

```yaml [config.yml]
environment:
  backends:
    history:
      type: git
      url: git@git.example.dev:acme/dev-environment.git
      branch: main
      path: environment
```

The devtool keeps a working copy of the repository in its cache folder
(`<adt.cacheDir>/environment/git/<name>`) and brings it to the remote branch before each operation.
Each push makes one commit, `devtool: push api/config.yml`, and pushes it; when the remote refuses it
because someone pushed meanwhile, the devtool rebases once and pushes again. A file that did not
change makes no commit. The branch is created by the first push when the repository does not have it.

It runs the `git` of your machine with its credentials, never asking for them: an SSH key or agent, or
a credential helper, must let `git push` work without a prompt. Commits carry your git identity, or
`devtool <devtool@localhost>` when git has none.

::: warning Large files
Git keeps every version of every file forever. Database archives and bucket snapshots of a few
megabytes pushed every day make the repository grow fast; keep them on another backend.
:::

::: tip
Do not edit the working copy in the cache folder: the devtool resets it to the remote branch each
time. Clone the repository elsewhere to read its history.
:::

| Key | Type | Default | Description |
|---|---|---|---|
| `url` | string | required | Address of the repository, as `git clone` takes it. |
| `branch` | string | `main` | Branch holding the files. |
| `path` | string | root of the repository | Folder of the files in the repository. |

## scripts

Your own commands, for any storage the other backends do not reach: a mounted folder, a drive, an
in-house API. The devtool runs one command per operation.

```yaml [config.yml]
environment:
  backends:
    shared:
      type: scripts
      cwd: scripts
      list: [ ./folder.sh, list ]
      download: [ ./folder.sh, download, "%{ADT:PATH}", "%{ADT:FILE}" ]
      upload: [ ./folder.sh, upload, "%{ADT:PATH}", "%{ADT:FILE}" ]
      remove: [ ./folder.sh, remove, "%{ADT:PATH}" ]
      env: { ROOT: /mnt/team/dev-environment }
```

### Ready-made scripts

[Download the example scripts](/devtool/examples/scripts-backend.zip){target="_self" download} and copy one next
to your configuration, in `~/.config/appsys/devtool/scripts/` for the example above:

| Script | Stores the files | Needs |
|---|---|---|
| `folder.sh` | in a folder given by `ROOT`: a shared or mounted folder (NFS, SMB, a synchronized drive) | bash, coreutils |
| `rclone.sh` | on any storage [rclone](https://rclone.org) reaches (Google Drive, Dropbox, OneDrive, WebDAV...), given by `REMOTE` | rclone, configured with `rclone config`, and [jq](https://jqlang.org) |

```bash
chmod +x ~/.config/appsys/devtool/scripts/folder.sh
ROOT=/mnt/team/dev-environment ~/.config/appsys/devtool/scripts/folder.sh list
```

For rclone, the backend reads:

```yaml [config.yml]
environment:
  backends:
    drive:
      type: scripts
      cwd: scripts
      list: [ ./rclone.sh, list ]
      download: [ ./rclone.sh, download, "%{ADT:PATH}", "%{ADT:FILE}" ]
      upload: [ ./rclone.sh, upload, "%{ADT:PATH}", "%{ADT:FILE}" ]
      remove: [ ./rclone.sh, remove, "%{ADT:PATH}" ]
      env: { REMOTE: "team-drive:dev-environment" }
```

### The protocol

A command is a list: the program, then its arguments. It runs in `cwd` (relative to the configuration
folder), without a shell, with the environment variables of the devtool plus `env`. In the arguments:

- `%{ADT:PATH}` is the path of the file in the environment, such as `api/db.gz`;
- `%{ADT:FILE}` is a local file: the one to write for `download`, the one to read for `upload`.

The arguments and the values of `env` read value blocks, so a script can receive a token from your
password manager.

| Operation | Must | Output |
|---|---|---|
| `list` | list every stored file | JSON on the standard output, see below |
| `download` | write the file at `path` into `%{ADT:FILE}` | exit code `2` when the file does not exist |
| `upload` | store `%{ADT:FILE}` at `path`, replacing the stored file | none |
| `remove` | delete the file at `path`; a missing file counts as deleted | none |

`list` prints:

```json
{
  "files": [
    { "path": "api/config.yml", "size": 1234, "updatedAt": "2026-01-15T09:30:00Z", "version": "1736933400-1234" }
  ]
}
```

`path`, `size` (bytes) and `updatedAt` (ISO 8601) are required. `version` must change whenever the file
is written, and only then: the devtool compares it to know whether a file changed since the last sync.
Without it, `updatedAt` is the version.

Any exit code other than `0`, and `2` for `download`, is a failure: the devtool reports
`upload of shared failed (exit 1): ` followed by the end of what the command wrote on its standard
error, so print a useful message there.

::: tip Write safe uploads
Write the file next to its place, then rename it, as `folder.sh` does: a cut upload then never leaves
a half written file behind.
:::

| Key | Type | Default | Description |
|---|---|---|---|
| `list` | command | required | Lists the stored files. |
| `download` | command | required | Writes a stored file into `%{ADT:FILE}`. |
| `upload` | command | required | Stores `%{ADT:FILE}`. |
| `remove` | command | required | Deletes a stored file. |
| `cwd` | string | the configuration folder | Folder the commands run in, relative to the configuration folder. |
| `env` | map of strings | none | Environment variables of the commands; value blocks are read. |

## Read and write a file by hand

`devtool env file` reads and changes any file of a backend, the default one unless you name another
with `-b`:

```bash
devtool env file pull api/config.yml ./config.yml
devtool env file pull api/config.yml - | less
devtool env file push api/config.yml ./config.yml -b nas
devtool env file rm api/old.yml -b nas
```

The files come as the backend keeps them, decrypted by the [encryption](/configuration/encryption) of
the backend but not by that of an item. The [CLI reference](/reference/cli#devtool-env-file) lists the
options.

## Reference

### environment.backends.&lt;name&gt;

Every backend takes these keys, on top of those of its type:

| Key | Type | Default | Description |
|---|---|---|---|
| `type` | `cdn`, `s3`, `sftp`, `git`, `scripts` | required | Kind of backend. |
| `default` | boolean | `false` | Items naming no backend, and the shared configuration, use this one. The first backend when none is marked. |
| `encryption` | map | none | Encrypt every file stored here: `{ key }`, `{ password }` or `{ prompt: true }`. See [Encryption](/configuration/encryption). |

The keys of each type are listed in its chapter: [cdn](#cdn), [s3](#s3), [sftp](#sftp), [git](#git),
[scripts](#scripts).

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
- `environment.backends.<name>.url: must be the http or https address of the CDN` (cdn)
- `environment.backends.<name>.bucket: must name the bucket`,
  `.accessKeyId: needs secretAccessKey, and the reverse`, `.pathStyle: must be true or false` (s3)
- `environment.backends.<name>.host: must name the SFTP server`,
  `.username: must name the user on the SFTP server`, `.port: must be a port between 1 and 65535` (sftp)
- `environment.backends.<name>.url: must be the address of the repository` (git)
- `environment.backends.<name>.<operation>: must be a command: a list of texts`,
  `.env: must be a map of texts` (scripts)
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
