# Scripts backends

Two working scripts for a `type: scripts` backend of the devtool environment, for storages the other
backends (cdn, s3, sftp, git) do not reach.

| Script | Stores the files | Needs |
|---|---|---|
| `folder.sh` | in a folder: a shared or mounted folder (NFS, SMB, a synchronized drive), given by `ROOT` | bash, coreutils |
| `rclone.sh` | on any storage rclone reaches (Google Drive, Dropbox, OneDrive, WebDAV, B2...), given by `REMOTE` | [rclone](https://rclone.org) 1.63 or later, configured with `rclone config`, and [jq](https://jqlang.org) |

## Use one

Copy the script next to your devtool configuration, for instance in
`~/.config/appsys/devtool/scripts/`, make it executable, and declare the backend:

```yaml
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
      default: true
  files:
    - devtool/config.yml
```

For rclone, use `./rclone.sh` and `env: { REMOTE: myremote:dev-environment }`.

`cwd` is relative to the configuration folder. The values of `env` and the arguments may hold value
blocks (`{{ op://... }}`, `{{ file://... }}`, `{{ $(...) }}`, `{{ auth://... }}`).

## The protocol

The devtool runs one command per operation, in `cwd`, without a shell. In the arguments,
`%{ADT:PATH}` stands for the path of the file in the environment (`api/db.gz`) and `%{ADT:FILE}` for the
local file to read or to write.

| Operation | Must |
|---|---|
| `list` | print on its standard output `{ "files": [ { "path", "size", "updatedAt", "version" } ] }`: the path relative to the storage, the size in bytes (left out when the storage cannot give it), the last change as an ISO 8601 date, and optionally a `version` that changes whenever the file is written (the date by default) |
| `download` | write the stored file to `%{ADT:FILE}`, or exit with code `2` when the path does not exist |
| `upload` | store `%{ADT:FILE}` at `%{ADT:PATH}`, replacing the stored file |
| `remove` | delete the stored file; a missing file counts as deleted |

Any other non-zero exit code is a failure: the devtool shows the end of the standard error.
