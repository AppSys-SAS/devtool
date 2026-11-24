---
description: Store the environment on a CDN that knows your team from its sign-in, and run your own with the example server.
---

# CDN

A `cdn` [backend](/configuration/backends) stores the files your team shares on a server of the
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

The documentation ships a small working server of the devtool files API. It stores the files on disk
and lets in the developers your identity provider signs in, by their groups. Use it as a starting
point, or as is for a small team.

[Download the example server](/devtool/examples/cdn-server.zip){target="_self" download} (Node.js 24, one
dependency, a Dockerfile).

::: warning Development only
The server shares the development environment of a team: configuration files, database dumps, bucket
snapshots. Do not store production data in it, and keep it behind your usual network protections.
:::

### Start it

```bash
npm install
ISSUER=https://auth.example.dev \
JWKS_URL=https://auth.example.dev/jwks.json \
AUDIENCE=https://files.example.dev \
READ_GROUPS=developers \
WRITE_GROUPS=leads \
npm start
```

Or with Docker:

```bash
docker build -t devtool-files .
docker run -p 3100:3100 -v devtool-files:/data \
  -e ISSUER=https://auth.example.dev \
  -e JWKS_URL=https://auth.example.dev/jwks.json \
  -e AUDIENCE=https://files.example.dev \
  devtool-files
```

Serve it over HTTPS behind your reverse proxy, since every request carries a bearer token, then point
a `cdn` backend at it.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3100` | Port the server listens on. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Folder storing the files. |
| `ISSUER` | required | Issuer of the access tokens, as in their `iss` claim. |
| `JWKS_URL` | required | Address of the public keys of the issuer. |
| `AUDIENCE` | required | Audience the access tokens must carry in `aud`. |
| `CLIENT_ID` | none | When set, the `client_id` claim the tokens must carry. |
| `READ_GROUPS` | `readers` | Comma separated groups allowed to list and download. |
| `WRITE_GROUPS` | `writers` | Comma separated groups allowed to upload and delete too. |
| `MAX_BYTES` | `1073741824` (1 GiB) | Largest file accepted. |

### What your identity provider must issue

The devtool signs in as a public client, with the authorization code flow and PKCE. In your identity
provider (Keycloak, Authelia, Authentik, Zitadel...), declare a client:

- public, without secret, with the redirect URI `http://127.0.0.1:6732/callback`;
- allowed the scopes `openid offline_access groups profile`;
- issuing **access tokens as JWT**, signed with RS256, of type `at+jwt`;
- adding your audience (`AUDIENCE`) to the access token without the devtool asking for it;
- putting the `groups` of the user in the access token.

The server checks the signature, the issuer, the audience and the expiry of each token (30 seconds of
tolerance), then the groups: a read group to list and download, a write group to upload and delete.

### The API

Write your own server, in any language, if this one does not fit: the devtool only needs these
routes.

| Request | Answer |
|---|---|
| `GET /devtool` | `200 {"files":[{"path","size","updatedAt"}]}`, every stored file |
| `GET /devtool/<path>` | the file, with its media type and its `Content-Length`; `404` when absent |
| `PUT /devtool/<path>` | stores the body, with the media type of `Content-Type`, replacing the file once it arrived whole; `204` |
| `DELETE /devtool/<path>` | deletes the file; `204`, even when it was absent |

Every request carries `Authorization: Bearer <access token>`. `updatedAt` is an ISO 8601 date that must
change whenever a file is written: the devtool compares it to know whether a file changed. Errors are
JSON with a `message` the devtool shows, such as
`{"statusCode":403,"message":"your groups do not allow this","error":"Forbidden"}`.

The example server also answers `GET /health` without token, and accepts paths of 1 to 16 segments
made of letters, digits, `.`, `_` and `-`, none starting with a dot.

## Reference

### environment.backends.&lt;name&gt; (type: cdn)

| Key | Type | Default | Description |
|---|---|---|---|
| `type` | `cdn` | required | |
| `url` | string | required | Base address of the CDN, `http` or `https`. A trailing `/` is removed. |
| `default` | boolean | `false` | See [Backends](/configuration/backends#the-default-backend). |
| `encryption` | map | none | See [Encryption](/configuration/encryption). |

### Warnings and errors

- `environment.backends.<name>: a cdn backend needs an auth section, signing the developers in`
- `environment.backends.<name>.url: must be the http or https address of the CDN`
- `cdn: is replaced by a backend of the environment: environment.backends.<name> { type: cdn, url }`
- `CDN <status>: <message>`: the CDN refused a call, such as `CDN 403: your groups do not allow this`.
