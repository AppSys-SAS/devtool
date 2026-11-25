---
description: Encrypt the files of the environment on your machine, before they reach their backend, with a key, a password, or a password you type.
---

# Encryption

The environment holds sensitive files: configurations with API keys, database copies with personal
data. Encryption keeps them unreadable to the storage holding them, and to anyone who gets a copy of
it. The devtool encrypts on your machine, before a file leaves it, and decrypts after it comes back:
the backend only ever sees encrypted bytes.

```yaml [config.yml]
environment:
  backends:
    archive:
      type: s3
      bucket: acme-dev-environment
      encryption: { key: "{{ op://dev/environment/key }}" }
  databases:
    - { path: api/db.gz, engine: postgres, container: postgres, backend: archive }
```

Everything stored in `archive` is now encrypted with a key read from 1Password.

## Two layers

Encryption can be set in two places, and both can apply to the same file.

- **On a backend**, `encryption` encrypts every file that backend stores. Use it when you trust the
  team but not the storage: a bucket of a cloud provider, a shared drive.
- **On a file**, with the `encryption` of an item or with the rules of `environment.encryption`, the
  file is encrypted before it reaches its backend, whatever that backend is. Use it for the few files
  that only some people may read, such as the secrets of a payment provider.

A file encrypted for itself and stored in an encrypted backend is encrypted twice, with two secrets:
reading it needs both.

```yaml [config.yml]
environment:
  backends:
    team:
      type: cdn
      url: https://files.example.dev
      encryption: { key: "{{ op://dev/environment/key }}" }
  encryption:
    - { paths: [ "payments/**" ], prompt: true }
  files:
    - devtool/config.yml
    - api/config.yml
    - payments/config.yml
```

Here every file of `team` is encrypted with the team key, and `payments/config.yml` is encrypted
before that with a password each developer types.

## Where the secret comes from

An `encryption` setting takes exactly one of three sources.

### `{ key }`: a key

```yaml [config.yml]
environment:
  backends:
    archive:
      type: s3
      bucket: acme-dev-environment
      encryption: { key: "{{ file://~/.config/acme/environment.key }}" }
```

A key is 32 random bytes written in base64, such as the output of `openssl rand -base64 32`. It is
the fastest source and the right one for a whole backend. Any other length stops the operation with
"the encryption key must be 32 bytes in base64".

### `{ password }`: a password

```yaml [config.yml]
environment:
  backends:
    nas:
      type: sftp
      host: nas.example.dev
      username: dev
      encryption: { password: "{{ op://dev/environment/password }}" }
```

A password of any length. The devtool stretches it with scrypt, with a random salt per file, so a
short password is still slow to guess; a long random one is better.

### `{ prompt: true }`: a password you type

```yaml [config.yml]
environment:
  encryption:
    - { paths: [ "payments/**" ], prompt: true }
  files:
    - payments/config.yml
```

The password is asked when a file needs it: in the terminal for `devtool env`, in a dialog of the
interface for the server. The dialog waits up to 5 minutes. The password is then kept in memory while
the devtool runs, once for each file, and asked again after a wrong one.

Without a terminal, as in a script or a CI job, the command stops with "the file payments/config.yml
needs a password: run the command in a terminal, or give the password with a value block".

::: tip Value blocks
`key` and `password` read [value blocks](/configuration/automation#value-blocks-read-secrets-at-the-last-moment):
`op://` for 1Password, `file://` for a file of your machine, `$(...)` for the output of a command. The
secret is then never written in a configuration file, and a value block can unlock many files without
asking you for each one.
:::

## Encrypt files by path

`environment.encryption` is a list of rules. Each rule names path patterns and a secret source:

```yaml [config.yml]
environment:
  encryption:
    - { paths: [ "payments/**", "**/.env" ], prompt: true }
    - { paths: [ "**/*.gz" ], key: "{{ op://dev/environment/archives-key }}" }
  files:
    - devtool/config.yml
    - payments/config.yml
    - web/.env
  databases:
    - { path: api/db.gz, engine: postgres, container: postgres }
```

- The rules apply to every item: files, databases, buckets and Redis databases, by their `path`.
- The first rule with a matching pattern wins.
- The `encryption` of an item overrides the rules:

```yaml [config.yml]
environment:
  encryption:
    - { paths: [ "**/*.gz" ], prompt: true }
  databases:
    - { path: api/db.gz, engine: postgres, container: postgres, encryption: { key: "{{ op://dev/api/db-key }}" } }
```

Patterns are globs: `*` matches within a folder, `**` across folders.

::: warning `*` skips dotfiles
`*` and `**` do not match a name starting with a dot. `web/*` does not match `web/.env`: write
`web/.env`, `**/.env` or `web/.*`.
:::

::: warning Keep the shared configuration out of the rules
A new developer downloads `devtool/config.yml` before knowing any rule, so it cannot be encrypted for
itself. Encrypt it with its backend instead, or not at all.
:::

## Generate a key or a password

<ClientOnly>
  <secret-generator />
</ClientOnly>

Store the secret where your team keeps its secrets, such as a shared vault of your password manager,
and read it with a value block.

## What it protects, and what it does not

Each file is encrypted with AES-256-GCM in chunks of 64 KiB, with a key derived for that file from
your secret and a random salt. Every chunk is authenticated, so a changed, reordered or cut file is
refused rather than decrypted into wrong data.

The path of the file is bound to its encryption: a file moved or copied to another path in the
backend does not decrypt. Store it again from its new path instead.

What the backend still sees:

- the paths of the files, and so their names;
- their sizes, a few bytes larger than the plain files;
- when they change.

::: danger Losing the secret loses the files
There is no recovery: without the key or the password, an encrypted file is lost. Keep the secret in
a vault the team shares, and test a pull on a second machine after you set it up.
:::

When the secret is wrong, a pull stops with `cannot decrypt <path>: wrong encryption secret, or
damaged file`, and leaves your local copy as it was. Other errors read `not a file encrypted by the
devtool` (a file stored without encryption, or by another tool) and `the file is cut short`.

::: tip Turning encryption on
Encryption applies to what is pushed after you set it. Files already stored as they are do not
decrypt: push them again once the setting is in place.
:::

## Reference

### encryption

On a backend (`environment.backends.<name>.encryption`) or on an item
(`environment.<list>[].encryption`), exactly one of:

| Key | Type | Description |
|---|---|---|
| `key` | string | 32 bytes in base64. Value blocks are read. |
| `password` | string | A password, stretched with scrypt. Value blocks are read. |
| `prompt` | `true` | Ask the password when a file needs it: in the terminal, or in a dialog of the interface. |

### environment.encryption[]

| Key | Type | Default | Description |
|---|---|---|---|
| `paths` | list of strings | required | Glob patterns of item paths, such as `secrets/**` or `**/.env`. |
| `key`, `password`, `prompt` | | one required | The secret, as for `encryption`. |

### Warnings and errors

- `environment.backends.<name>.encryption: must be { key } (32 bytes in base64), { password } or { prompt: true }`
- `invalid encryption rule in the environment: environment.encryption[<index>] needs paths and ...`:
  a rule lacks `paths` or a single secret source.
- `invalid encryption of <path> in the environment: ...`: the `encryption` of an item is not one of
  the three sources.
- `the encryption key must be 32 bytes in base64, such as the output of openssl rand -base64 32`
- `cannot decrypt <path>: wrong encryption secret, or damaged file`
- `cannot decrypt <path>: not a file encrypted by the devtool`
- `cannot decrypt <path>: the file is cut short`
- `<label> needs a password: run the command in a terminal, or give the password with a value block`
