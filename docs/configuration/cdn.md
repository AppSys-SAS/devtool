---
description: Connect the devtool to the CDN that stores the shared environment.
---

# CDN

The CDN stores the files your team shares: the devtool configuration, application configurations,
database archives, bucket snapshots. Every call carries the access token of your
[sign-in](/configuration/auth), and the CDN decides from it who may download, upload and delete.
Configure it once and the [environment](/configuration/environment) commands work for everyone.

```yaml [config.local.yml]
auth:
  issuer: https://auth.example.dev
  clientId: devtool
cdn:
  url: https://cdn.example.dev
```

The CDN needs an [`auth`](/configuration/auth) section: without it, the devtool warns
`cdn: needs an auth section, signing the developers in` and cannot reach the CDN.

::: tip Where to put it
A new developer has no shared configuration yet, so `auth` and `cdn` usually go in their
`config.local.yml` first. Once `devtool env pull` brought the shared `config.yml`, they can live there too.
:::

## Sign in

```bash
devtool login
```

Sign-in is described on the [Sign-in](/configuration/auth) page. The CDN calls renew the access token
on their own when it expires.

## Files by hand

The CDN keeps the devtool files under `<url>/devtool/`. You can read and change them directly:

```bash
devtool cdn pull api/config.yml              # into ./config.yml
devtool cdn pull api/config.yml - | less     # to the standard output
devtool cdn push api/config.yml ./config.yml -t text/yaml
devtool cdn rm api/old.yml
```

- `pull` refuses an incomplete download and writes the destination only once the file is whole.
- `push` and `rm` need write rights, which the CDN grants from your token.
- `-t` sets the media type served with the file, `application/octet-stream` by default.

## Reference

### cdn

| Key | Type | Default | Description |
|---|---|---|---|
| `url` | string | required | Base URL of the CDN. A trailing `/` is removed. |

### Warnings and errors

- `cdn: needs an auth section, signing the developers in`
- Without `url`, the CDN counts as not configured, and the CLI stops with "no `cdn` section (url) in the
  devtool configuration". Without a complete `auth` section, it stops naming what `auth` misses.
