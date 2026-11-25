---
description: Store the environment on a CDN that knows your team from its sign-in.
---

# CDN

A `cdn` [backend](/configuration/environment/backends) stores the files your team shares on a server of the
devtool files API. Unlike a bucket or a file server, it needs no key on the machines of the
developers: every call carries the access token of your [sign-in](/configuration/auth), and the server
decides from it, usually from your groups, who may download, upload and delete. Someone who leaves
the team loses access when their account is closed.

```yaml [config.local.yml]
auth:
  issuer: https://auth.example.dev
  clientId: devtool
environment:
  backends:
    team:
      type: cdn
      url: https://files.example.dev
      default: true
```

A `cdn` backend needs an [`auth`](/configuration/auth) section: without it, the devtool warns
`environment.backends.team: a cdn backend needs an auth section, signing the developers in` and cannot
reach the CDN.

::: tip Where to put it
A new developer has no shared configuration yet, so `auth` and the default backend usually go in
their `config.local.yml` first. Once `devtool env pull` brought the shared `config.yml`, they can live
there too.
:::

::: warning Migrating from the `cdn` section
The former top-level `cdn: { url }` section becomes a backend, `environment.backends.<name>` with
`type: cdn` and the same `url`. The devtool ignores the old section and warns `cdn: is replaced by a
backend of the environment`.
:::

## Sign in

```bash
devtool login
```

Sign-in is described on the [Sign-in](/configuration/auth) page. The calls to the CDN renew the access
token on their own when it expires.

## Files by hand

The CDN keeps the devtool files under `<url>/devtool/`. You can read and change them directly:

```bash
devtool env file pull api/config.yml              # into ./config.yml
devtool env file pull api/config.yml - | less     # to the standard output
devtool env file push api/config.yml ./config.yml
devtool env file rm api/old.yml
```

- `pull` refuses an incomplete download and writes the destination only once the file is whole.
- `push` and `rm` need write rights, which the CDN grants from your token.
- `push` guesses the media type served with the file from its name; `-t` sets another one.
- `-b <name>` picks another backend than the default one.

## Run your own CDN

Any server of the devtool files API works. [Run a CDN server](/examples/cdn-server) ships a small
working one, describes the API the devtool needs and what your identity provider must issue.

## Reference

### environment.backends.&lt;name&gt; (type: cdn)

| Key | Type | Default | Description |
|---|---|---|---|
| `type` | `cdn` | required | |
| `url` | string | required | Base address of the CDN, `http` or `https`. A trailing `/` is removed. |
| `default` | boolean | `false` | See [Backends](/configuration/environment/backends#the-default-backend). |
| `encryption` | map | none | See [Encryption](/configuration/environment/encryption). |

### Warnings and errors

- `environment.backends.<name>: a cdn backend needs an auth section, signing the developers in`
- `environment.backends.<name>.url: must be the http or https address of the CDN`
- `cdn: is replaced by a backend of the environment: environment.backends.<name> { type: cdn, url }`
- `CDN <status>: <message>`: the CDN refused a call, such as `CDN 403: your groups do not allow this`.
