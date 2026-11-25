# Development tools

Databases, a mail catcher, an S3 server and their consoles, for a local development environment run
by the devtool.

```bash
docker compose up -d
```

| Tool | Address |
|---|---|
| PostgreSQL | `postgresql://dev:dev@localhost:5432/app` |
| MariaDB | `mysql://dev:dev@localhost:3306/app` |
| Redis | `redis://localhost:6379` |
| Mailpit | SMTP `localhost:1025`, web <http://localhost:8025> |
| S3 | API <http://localhost:9000>, console <http://localhost:9001> (`minioadmin` / `minioadmin`) |
| Redis Insight | <http://localhost:5540> |
| db-studio | <http://localhost:3333> (password `dev`) |

The documentation shows how to declare them in the devtool:
https://appsys-sas.github.io/devtool/examples/dev-tools
