# Contributing

Thanks for taking the time to improve the devtool. Bug reports, ideas, documentation fixes and pull
requests are all welcome.

## Report a bug or suggest an idea

Open an [issue](https://github.com/AppSys-SAS/devtool/issues) with what you expected, what happened,
and the smallest configuration that shows it. Remove secrets and internal host names from what you paste.
For a security problem, follow the [security policy](https://github.com/AppSys-SAS/devtool/blob/main/SECURITY.md) instead.

## Set up the repository

You need Node.js 24 (see `.node-version`) and pnpm, through Corepack:

```bash
corepack enable
pnpm install
pnpm build
```

The repository is a pnpm workspace:

| Folder | Content |
|---|---|
| `apps/cli` | the `devtool` command, published as `@appsys/devtool` |
| `apps/server` | the API and WebSocket server, command streams and load balancer |
| `apps/proxy` | the TCP proxy forwarding port 443 to the load balancer |
| `apps/ui` | the web interface (Vue, Vite, Tailwind, shadcn-vue) |
| `packages/config` | loading and merging of the YAML configuration, and its JSON schema |
| `packages/auth` | sign-in with the identity provider (OpenID Connect) |
| `packages/environment` | the development environment and its backends (CDN, S3, SFTP, git, scripts) |
| `packages/certs` | certificate renewal |
| `packages/git` | repositories, pull requests and issues of GitHub and GitLab |
| `packages/mcp` | the MCP server for coding agents |
| `packages/shared` | types and helpers shared by the apps |
| `packages/skills` | agent skills teaching coding agents to use the devtool, in its `skills` folder |
| `docs` | this documentation site (VitePress) |
| `e2e` | end-to-end tests (Playwright) |

## Run it while you work

```bash
pnpm dev          # server and interface with hot reload
pnpm dev:ui       # interface only
pnpm dev:server   # server only
pnpm dev:cli      # any CLI command, for instance: pnpm dev:cli env pull
pnpm docs:dev     # documentation site
```

## Check your change

The packages resolve each other through their built `lib/`, so build before checking:

```bash
pnpm build
pnpm typecheck   # tsc 7; the TypeScript 6 API stays installed for ESLint
pnpm lint        # ESLint with the style rules, `pnpm lint --fix` applies them
pnpm test        # Vitest unit tests, and every configuration example of the docs against the schema
pnpm test:e2e    # Playwright end-to-end tests
pnpm docs:build  # documentation site, fails on dead links
```

The end-to-end tests start a devtool on ports 16730 and 16731 with the configuration of
`e2e/fixtures`, copied to a temporary folder (`$E2E_FOLDER`, `devtool-e2e` in the system temporary
folder by default). They need Chromium once: `pnpm exec playwright install chromium`.

## Configuration changes

A new or changed configuration key touches three places, kept in step by the tests:

1. the code reading it (`apps/server/src/configure.ts` for most keys);
2. the JSON schema, `packages/config/schema/config.schema.json`;
3. its page in `docs/configuration/`, with an example: every YAML example of the docs is validated against
   the schema by `pnpm test`.

## Commits and pull requests

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`,
`chore:` and so on. release-please turns them into the changelog and the version of the next release.
Pull requests are squashed with their title as the commit message, so give the pull request a
Conventional Commits title.

## Releases

Every package shares one version. On each push to `main`, release-please opens or updates a release
pull request that bumps that version in every `package.json` and writes the changelog. Merging it tags
`vX.Y.Z`, creates the GitHub release, then the `Publish to npm` job of
`.github/workflows/release-please.yml` builds the workspace and runs
`pnpm -r publish --access public --provenance`:

- every package that is not `private` is published, dependencies first, `workspace:*` replaced by the
  released version; a version already on npm is skipped, so a failed job can be run again;
- `@appsys/devtool` is the package people install: it holds the `devtool` command and depends on the
  others, among them `@appsys/devtool-ui`, which only ships the built interface (`dist`), so its
  build-time dependencies are `devDependencies`;
- each package is signed with an npm provenance statement linking it to the workflow run, which needs
  the `repository` field of its `package.json` to point at this repository.

release-please acts as a GitHub App of the organization, not with the default `GITHUB_TOKEN`: GitHub
starts no workflow for a pull request opened with that token, so the release pull request would never get
its CI checks. The App needs the repository permissions "Contents" and "Pull requests" (read and write)
and must be installed on this repository; the workflow reads its Client ID from the `RELEASE_APP_CLIENT_ID`
repository variable and its private key from the `RELEASE_APP_PRIVATE_KEY` repository secret.

The job reads an npm token from the `NPM_TOKEN` repository secret: a granular access token of an npm
account that can publish to the `@appsys` scope, with read and write permission on its packages and
"bypass two-factor authentication" enabled. Once the packages exist, they can move to
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (the workflow already has the
`id-token: write` permission it needs) and the secret can be removed.

To check the packages before a release, pack them and install the result in a throwaway prefix:

```bash
pnpm build
pnpm -r --filter "./apps/**" --filter "./packages/**" pack --pack-destination /tmp/devtool-packs
npm install -g --prefix /tmp/devtool-prefix /tmp/devtool-packs/*.tgz
/tmp/devtool-prefix/bin/devtool --version
```

By contributing, you agree that your contribution is licensed under the
[Apache License 2.0](https://github.com/AppSys-SAS/devtool/blob/main/LICENSE).
