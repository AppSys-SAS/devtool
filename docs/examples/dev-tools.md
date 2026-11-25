---
description: The tools that pair well with the devtool, a docker-compose file to run them and how to plug them in.
---

# Recommended tools

The devtool runs your projects; these open-source tools give them what they need around them: databases,
a mail catcher, an S3 server, and consoles to look inside. They all run in Docker, side by side, from one
`docker-compose.yml`.

[Download the example](/devtool/examples/dev-tools.zip){target="_self" download} (a `docker-compose.yml`
and a README).

| Tool | What it is for | Address |
|---|---|---|
| [PostgreSQL](https://www.postgresql.org) and [MariaDB](https://mariadb.org) | the databases of your apps | `localhost:5432`, `localhost:3306` |
| [Redis](https://redis.io) | cache, sessions and queues | `localhost:6379` |
| [Mailpit](https://mailpit.axllent.org) | catches every mail your apps send, and shows them in a web page | SMTP `localhost:1025`, web `localhost:8025` |
| [Silo](https://github.com/pgsty/silo) | S3-compatible storage, a maintained build of MinIO | API `localhost:9000`, console `localhost:9001` |
| [Redis Insight](https://redis.io/insight) | browses and edits the keys of Redis | `localhost:5540` |
| [db-studio](https://github.com/husamql3/db-studio) | one console for PostgreSQL, MySQL, MariaDB, SQLite, MongoDB, Redis and more | `localhost:3333` |

::: tip Inside Docker, use the service names
A console running in the same compose reaches the databases by their service name: in db-studio, connect
to `postgresql://dev:dev@postgres:5432/app`, not `localhost`.
:::

## The compose file

::: code-group

<<< @/examples/dev-tools/docker-compose.yml

<<< @/examples/dev-tools/README.md

:::

## Start them with the devtool

Give the tools a project of their own: they start with its section, and their logs live in a terminal
like the ones of your apps.

```yaml [config.yml]
sections:
  tools: { name: Tools, path: tools }
projects:
  dev-tools:
    section: tools
    name: Development tools
    path: .
    default: { action: command:up }
    commands:
      up: { name: Start, args: [ docker, compose, up ], startWithSection: true }
      down: { name: Stop, args: [ docker, compose, down ] }
      pull: { name: Update the images, args: [ docker, compose, pull ] }
```

Put the `docker-compose.yml` in the folder of the project (`tools/` of your workspace here).

## Open the consoles in the devtool

Give each console an HTTPS name through the load balancer, then show it in the sidebar: the pages open
inside the devtool, next to your terminals.

```yaml [config.yml]
projects:
  dev-tools:
    services:
      mail: { host: mail.example.dev, target: 8025, tls: true }
      redis: { host: redis.example.dev, target: 5540, tls: true }
      db: { host: db.example.dev, target: 3333, tls: true }
      s3: { host: s3.example.dev, target: 9001, tls: true }
integrations:
  mail: { name: Mailpit, icon: mdi:email, url: "https://mail.example.dev" }
  redis: { name: Redis Insight, icon: simple-icons:redis, url: "https://redis.example.dev" }
  db: { name: db-studio, icon: mdi:database, url: "https://db.example.dev" }
  s3: { name: S3 console, icon: mdi:bucket, url: "https://s3.example.dev" }
```

See [Services](/configuration/services) for the names and certificates, and
[Integrations](/configuration/integrations) for the pages of the sidebar.

## Point your apps at them

The commands of your projects get the addresses in their environment:

```yaml [config.yml]
projects:
  api:
    commands:
      dev:
        name: Dev server
        args: [ pnpm, dev ]
        env:
          DATABASE_URL: postgresql://dev:dev@localhost:5432/app
          REDIS_URL: redis://localhost:6379/0
          SMTP_HOST: localhost
          SMTP_PORT: "1025"
          S3_ENDPOINT: http://localhost:9000
          S3_ACCESS_KEY_ID: minioadmin
          S3_SECRET_ACCESS_KEY: minioadmin
```

Every mail the API sends now lands in Mailpit, never in a real mailbox.

## Share their data with the team

The [environment](/configuration/environment/) dumps and restores the databases, Redis and the buckets
of these tools, so a new developer starts with the data of the team:

```yaml [config.yml]
environment:
  s3: { endpoint: "http://localhost:9000", accessKeyId: minioadmin, secretAccessKey: minioadmin }
  databases:
    - { path: api/db.gz, engine: postgres, container: postgres }
    - { path: shop/db.gz, engine: mariadb, container: mariadb }
  redis:
    - { path: api/redis.gz, url: "redis://localhost:6379/0" }
  buckets:
    - { path: api/uploads.gz, bucket: uploads }
  files:
    - db-studio/connections.json
```

`devtool env pull` then fills the local tools, and `devtool env push` shares their state.

## Command-line tools

A few command-line tools make the configuration simpler:

| Tool | Use in the devtool |
|---|---|
| [Docker](https://www.docker.com) | runs the tools above, and the dumps and restores of the databases |
| [GitHub CLI](https://cli.github.com) | gives integrations a token without storing it: <code v-pre>token: "{{ $(gh auth token) }}"</code> |
| [1Password CLI](https://developer.1password.com/docs/cli) | reads secrets when a command starts: <code v-pre>"{{ op://dev/api/password }}"</code> |
| [lego](https://go-acme.github.io/lego/) | renews the HTTPS certificates of your names with ACME, see [Certificates](/configuration/certificates) |

See [Automation and secrets](/configuration/automation) for the value blocks.
