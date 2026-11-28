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
password manager. Those of `env`, `list` and `download` are read once, before the first transfer,
those of `upload` and `remove` the first time they run, so a pull never reads the secrets of the
commands that write; the time you take to approve their reading is not counted, and a transfer
waiting for it can be cancelled. A command never waits for input: its standard input reads `/dev/null`.
Every command runs in a session of its own, without terminal, so that stopping one stops every
process it started that stays in that session (a process that starts a session of its own, such
as a daemon, is not reached): when a transfer is cancelled, when the command shows no activity for a minute
(see [Progress](#progress)), and when devtool itself is stopped. A command ends once its own process
exits, even when a process it detached, such as a persistent SSH connection, still holds its output;
the processes it left running in its session are then stopped, so a command must wait for its work. `upload` must therefore
replace the stored file only once it is complete, such as by writing a temporary file renamed at the
end.

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

`path` and `updatedAt` (ISO 8601) are required. `size` (bytes) is left out, or `null`, when the storage
cannot give it: the Environment page then shows the size as unknown, and a pull shows the bytes received
without a total. `version` must change whenever the file is written, and only then: the devtool compares
it to know whether a file changed since the last sync. Without it, `updatedAt` is the version.

Any exit code other than `0`, and `2` for `download`, is a failure: the devtool reports
`upload of shared failed (exit 1): ` followed by the end of what the command wrote on its standard
error, so print a useful message there.

::: tip Write safe uploads
Write the file next to its place, then rename it, as `folder.sh` does: a cut upload then never leaves
a half written file behind.
:::

### Progress

While `download` runs, the devtool shows the size `%{ADT:FILE}` has reached, and stops the command
when that size does not grow for a minute. A tool that writes elsewhere first, then renames its file
at the end, reports what it received with lines `progress: <bytes received>` on its standard error
instead. `list` must answer within a minute. `upload` reports its own progress the same way, with
lines `progress: <bytes sent>`, such as `progress: 1048576`; once it printed one, the devtool stops it
when no new one comes for a minute, until it reported the whole file. Without them, the upload shows
its end only and is never stopped for being silent.

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
