# Devtool files server (example)

A minimal server of the devtool files API, the API the `cdn` backend of the devtool talks to. It stores
the files on disk and lets in the developers your identity provider signs in, by their groups. Use it
as a starting point, or as is for a small team.

::: warning Development only
This server shares the development environment of a team: configuration files, database dumps,
bucket snapshots. Do not store production data in it, and keep it behind your usual network
protections.
:::

## What it serves

| Request | Answer |
|---|---|
| `GET /health` | `200 {"status":"ok"}`, no token needed |
| `GET /devtool` | `200 {"files":[{"path","size","updatedAt"}]}`, every stored file |
| `GET` or `HEAD /devtool/<path>` | the file, with its media type and exact length; `404` when absent |
| `PUT /devtool/<path>` | stores the body, replacing the file once it arrived whole; `204` |
| `DELETE /devtool/<path>` | deletes the file, `204` even when it was absent |

A path has 1 to 16 segments, each made of letters, digits, `.`, `_` and `-` and not starting with a
dot, 512 characters at most; any other path answers `404`. Errors are JSON:
`{"statusCode":403,"message":"your groups do not allow this","error":"Forbidden"}`.

Every `/devtool` request needs `Authorization: Bearer <access token>`:

- the token must be a JWT signed with RS256 by your issuer, of type `at+jwt`, for your audience, not
  expired (30 seconds of tolerance);
- listing and downloading need one of the read or write groups in the `groups` claim of the token;
  uploading and deleting need a write group.

## Run it

You need Node.js 24 or later.

```bash
npm install
ISSUER=https://auth.example.dev \
JWKS_URL=https://auth.example.dev/jwks.json \
AUDIENCE=https://files.example.dev \
READ_GROUPS=developers \
WRITE_GROUPS=leads \
npm start
```

With Docker:

```bash
docker build -t devtool-files .
docker run -p 3100:3100 -v devtool-files:/data \
  -e ISSUER=https://auth.example.dev \
  -e JWKS_URL=https://auth.example.dev/jwks.json \
  -e AUDIENCE=https://files.example.dev \
  devtool-files
```

Serve it over HTTPS behind your reverse proxy: the devtool sends a bearer token with every request.

## Settings

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

The files are stored under `DATA_DIR` at their path. Their media types are kept under `DATA_DIR/.meta`,
and uploads in progress under `DATA_DIR/.tmp`, so a cut upload never replaces a stored file.

## Your identity provider

The devtool signs in as a public client with the authorization code flow and PKCE. In your identity
provider (Keycloak, Authelia, Authentik, Zitadel...), declare a client:

- public, without secret, with the redirect URI `http://127.0.0.1:6732/callback`;
- allowed the scopes `openid offline_access groups profile`;
- issuing **access tokens as JWT** signed with RS256, of type `at+jwt`;
- adding your audience to the access token without the devtool asking for it;
- putting the `groups` of the user in the access token.

## Plug it in the devtool

Declare the server as a backend of the environment, and the identity provider in `auth`:

```yaml [config.yml]
auth:
  type: openid
  name: My SSO
  issuer: https://auth.example.dev
  clientId: devtool
environment:
  backends:
    team:
      type: cdn
      url: https://files.example.dev
      default: true
  files:
    - devtool/config.yml
```

Then `devtool login` and `devtool env pull`.
