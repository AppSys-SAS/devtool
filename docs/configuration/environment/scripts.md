---
description: Store the environment anywhere your own commands reach, with one command per operation.
---

# Scripts

A `scripts` [backend](/configuration/environment/backends) runs your own commands, for any storage
the other backends do not reach: a mounted folder, a drive, an in-house API. The devtool runs one
command per operation.

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

::: tip Ready-made scripts
[Backend scripts](/examples/backend-scripts) ships two working scripts to copy: `folder.sh`, used
above, for a shared or mounted folder, and `rclone.sh` for any storage rclone reaches.
:::

## The protocol

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

### Progress

While `download` runs, the devtool shows the size `%{ADT:FILE}` has reached. `upload` reports its own
progress by printing lines `progress: <bytes sent>` on its standard error, such as `progress: 1048576`;
without them, the upload shows its end only.

## Read-only storage

A storage the developers only read from, such as archives published by another job, needs no
`upload` nor `remove` when the backend refuses every push with `groups: { push: false }`:

```yaml [config.yml]
environment:
  backends:
    dumps:
      type: scripts
      list: [ ./dumps.sh, list ]
      download: [ ./dumps.sh, download, "%{ADT:PATH}", "%{ADT:FILE}" ]
      groups: { push: false }
```

Pushes of its items, even those naming their own groups, and `devtool env file push` and `rm`, are then
refused before any command runs.

## Reference

### environment.backends.&lt;name&gt; (type: scripts)

| Key | Type | Default | Description |
|---|---|---|---|
| `type` | `scripts` | required | |
| `list` | command | required | Lists the stored files. |
| `download` | command | required | Writes a stored file into `%{ADT:FILE}`. |
| `upload` | command | required, unless `groups.push` is `false` | Stores `%{ADT:FILE}`. |
| `remove` | command | required, unless `groups.push` is `false` | Deletes a stored file. |
| `cwd` | string | the configuration folder | Folder the commands run in, relative to the configuration folder. |
| `env` | map of strings | none | Environment variables of the commands; value blocks are read. |
| `default` | boolean | `false` | See [Backends](/configuration/environment/backends#the-default-backend). |
| `encryption` | map | none | See [Encryption](/configuration/environment/encryption). |
| `groups` | map | everyone | See [Who may pull and push](/configuration/environment/#who-may-pull-and-push). |

### Warnings

- `environment.backends.<name>.<operation>: must be a command: a list of texts`
- `environment.backends.<name>.env: must be a map of texts`
