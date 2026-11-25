---
description: Store the environment in a folder of an SFTP server, a NAS or any machine you reach with SSH.
---

# SFTP

An `sftp` [backend](/configuration/environment/backends) stores the files in a folder of an SFTP
server: a NAS, a shared server of the team, any machine you reach with SSH.

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

## Reference

### environment.backends.&lt;name&gt; (type: sftp)

| Key | Type | Default | Description |
|---|---|---|---|
| `type` | `sftp` | required | |
| `host` | string | required | Host name of the server. |
| `port` | integer | `22` | SSH port. |
| `username` | string | required | User on the server. |
| `path` | string | `.` | Folder of the files, relative to the home folder of the user when not absolute. |
| `privateKey` | string | none | Private key file; `~/` is your home folder. |
| `passphrase` | string | none | Passphrase of the private key; value blocks are read. |
| `password` | string | none | Password of the user; value blocks are read. |
| `default` | boolean | `false` | See [Backends](/configuration/environment/backends#the-default-backend). |
| `encryption` | map | none | See [Encryption](/configuration/environment/encryption). |

### Warnings

- `environment.backends.<name>.host: must name the SFTP server`
- `environment.backends.<name>.username: must name the user on the SFTP server`
- `environment.backends.<name>.port: must be a port between 1 and 65535`
