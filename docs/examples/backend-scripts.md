---
description: Two working scripts for a scripts backend, storing the environment in a shared folder or on any storage rclone reaches.
---

# Backend scripts

Two working scripts for a [`scripts` backend](/configuration/environment/scripts), for storages the
other backends do not reach.

[Download the example scripts](/devtool/examples/scripts-backend.zip){target="_self" download} and copy one next
to your configuration, in `~/.config/appsys/devtool/scripts/` for the
[example backend](/configuration/environment/scripts):

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

Both follow [the protocol](/configuration/environment/scripts#the-protocol) of the `scripts` backend.

## The code

::: code-group

<<< @/examples/scripts-backend/folder.sh

<<< @/examples/scripts-backend/rclone.sh

:::
