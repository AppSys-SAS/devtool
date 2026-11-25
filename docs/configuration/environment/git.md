---
description: Store the environment in a git repository, one commit per push, with a history you can read and revert.
---

# Git

A `git` [backend](/configuration/environment/backends) stores the files in a git repository, for
teams that want every change of the environment in a history they can read and revert.

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

## Reference

### environment.backends.&lt;name&gt; (type: git)

| Key | Type | Default | Description |
|---|---|---|---|
| `type` | `git` | required | |
| `url` | string | required | Address of the repository, as `git clone` takes it. |
| `branch` | string | `main` | Branch holding the files. |
| `path` | string | root of the repository | Folder of the files in the repository. |
| `default` | boolean | `false` | See [Backends](/configuration/environment/backends#the-default-backend). |
| `encryption` | map | none | See [Encryption](/configuration/environment/encryption). |

### Warnings

- `environment.backends.<name>.url: must be the address of the repository`
