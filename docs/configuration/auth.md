---
description: Sign developers in once with your identity provider, for the CDN and for the auth value blocks of commands.
---

# Sign-in (auth)

The `auth` section names the identity provider your team signs in with. You sign in once, and the
devtool reuses that session everywhere it needs to know who you are: the [CDN](/configuration/cdn) gets
your access token, and your commands can read your token, user name and groups with
[value blocks](#values-of-the-signed-in-developer).

```yaml [config.yml]
auth:
  type: openid
  name: My SSO
  issuer: https://auth.example.dev
  clientId: devtool
```

`type` names the kind of identity provider. Only `openid` (OpenID Connect) exists today, and it is the
default; other kinds may come later.

## Sign in and out

```bash
devtool login
devtool logout
```

`devtool login` opens the issuer in your browser (authorization code with PKCE, as a public client: no
secret to share) and waits for the redirect on `http://127.0.0.1:<callbackPort>/callback`. Register that
address as a redirect URI of the `clientId` client in your identity provider. You can also sign in from
the interface: with [`adt.sidebar.login`](/configuration/devtool), the sidebar shows who is signed in and
a Sign in button.

The tokens are kept in `session.json` in the configuration folder, readable by you only (mode 600). When
the access token expires, the devtool renews it with the refresh token, one devtool process at a time,
and reads your identity again: a group you just joined shows up at the next renewal.
`devtool logout` forgets the session.

## Scopes

`scopes` lists what the devtool asks the issuer for. The default is
`openid offline_access groups profile`: your identity, a refresh token, your groups and your names.

To read your email, add `email`:

```yaml [config.yml]
auth:
  issuer: https://auth.example.dev
  clientId: devtool
  scopes: [ openid, offline_access, groups, profile, email ]
```

::: warning Ask only for what the client may get
The issuer must allow every scope for the `clientId` client. If it does not, the sign-in fails. Check the
client in your identity provider before adding a scope.
:::

## Values of the signed-in developer

:::: v-pre

A command reads who you are with `{{ auth://<value> }}` value blocks, like the other
[value blocks](/configuration/automation#value-blocks):

| Block | Value |
|---|---|
| `{{ auth://token }}` | Your access token, renewed first when it expired. |
| `{{ auth://username }}` | Your user name. |
| `{{ auth://name }}` | Your display name. |
| `{{ auth://email }}` | Your email, when the `email` scope is asked. |
| `{{ auth://groups }}` | Your groups, separated by commas. |

They are read in `args`, `env` and answers of commands, in the `token` of integrations, in the `env` of
agents and in certificate renewals. Every value read is masked in the output of the command.

Call an API of your team with your own token:

```yaml [config.yml]
projects:
  api:
    commands:
      whoami:
        name: Who am I
        args: [ curl, -sf, -H, "Authorization: Bearer {{ auth://token }}", https://api.example.dev/me ]
```

Tell a dev server who you are:

```yaml [config.yml]
projects:
  web:
    commands:
      dev:
        name: Vite
        args: [ pnpm, dev ]
        env:
          DEV_USER: "{{ auth://username }}"
          DEV_GROUPS: "{{ auth://groups }}"
```

Read the pull requests of a forge that accepts the same token:

```yaml [config.yml]
projects:
  api:
    integrations:
      pulls: { name: Pull requests, type: pullRequests, provider: gitlab, url: "https://git.example.dev/acme/api", token: "{{ auth://token }}" }
```

::: warning When there is no value
If you are not signed in, the command stops before starting with `not signed in: run devtool login`.
If the identity provider gives no such value (an email without the `email` scope), it stops with
`auth://email: My SSO gives no email`. Without `auth` section, it stops with
`no auth section in the devtool configuration`.
:::

::::

## Reference

### auth

| Key | Type | Default | Description |
|---|---|---|---|
| `type` | `openid` | `openid` | Kind of identity provider. |
| `name` | string | none | Name of the identity provider shown in the sign-in texts. |
| `issuer` | string | required | OpenID Connect issuer. A trailing `/` is removed. |
| `clientId` | string | required | Public client of the devtool at the issuer. |
| `callbackPort` | integer | `6732` | Local port the issuer redirects to. |
| `scopes` | list of strings | `[ openid, offline_access, groups, profile ]` | Scopes asked at sign-in, holding `openid`. |

### Warnings

- `auth.type: must be one of openid`
- `auth.issuer: must be the address of the OpenID Connect issuer`
- `auth.clientId: must be the client of the devtool at the issuer`
- `auth.callbackPort: must be a port between 1 and 65535, 6732 is used`
- `auth.scopes: must be a list of scopes holding openid, openid offline_access groups profile is used`
- `cdn: needs an auth section, signing the developers in`: a `cdn` section is declared without `auth`.
