---
description: Connect the devtool to the CDN that stores the shared environment, with an OpenID Connect sign-in.
---

# CDN

The CDN stores the files your team shares: the devtool configuration, application configurations,
database archives, bucket snapshots. Every call carries an access token from your identity provider, and
the CDN decides from it who may download, upload and delete. Configure it once and the
[environment](/configuration/environment) commands work for everyone.

```yaml [config.local.yml]
cdn:
  url: https://cdn.example.dev
  openid:
    issuer: https://auth.example.dev
    clientId: devtool
```

::: tip Where to put it
A new developer has no shared configuration yet, so the `cdn` section usually goes in their
`config.local.yml` first. Once `devtool env pull` brought the shared `config.yml`, it can live there too.
:::

## Sign in

```bash
devtool login
```

The devtool opens the issuer in your browser (authorization code with PKCE, as a public client: no secret
to share) and waits for the redirect on `http://127.0.0.1:<callbackPort>/callback`. Register that address
as a redirect URI of the `clientId` client in your identity provider.

The tokens are kept in `session.json` in the configuration folder, readable by you only (mode 600). The
access token is renewed with the refresh token when it expires, one devtool process at a time.
`devtool server` signs in first when no session exists. `devtool logout` forgets the session.

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
| `openid.issuer` | string | required | OpenID Connect issuer. A trailing `/` is removed. |
| `openid.clientId` | string | required | Public client of the devtool at the issuer. |
| `openid.name` | string | none | Name of the identity provider shown in the sign-in texts. |
| `openid.callbackPort` | integer | `6732` | Local port the issuer redirects to. |

### Errors

The `cdn` section shows no warning: when `url`, `openid.issuer` or `openid.clientId` is missing, the CDN
simply counts as not configured, and the CLI stops with "no `cdn` section (url, openid.issuer,
openid.clientId) in the devtool configuration". An invalid `callbackPort` falls back to `6732`.
