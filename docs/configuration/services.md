---
description: Serve your projects on real host names over HTTPS through the load balancer of the devtool.
---

# Services

A service gives a project a real address, such as `https://web.example.dev`, instead of
`http://localhost:5173`. The load balancer of the devtool receives the request, finds the service whose
host matches, and forwards it to your dev server.

Real host names make cookies, OAuth redirects and CORS behave like in production, and every developer of
the team uses the same addresses.

## A first service

```yaml [config.yml]
projects:
  web:
    commands:
      dev: { name: Vite, args: [ pnpm, dev ] }
    services:
      web: { host: web.example.dev, target: 5173, tls: true }
```

Requests for `web.example.dev` now go to port 5173 of this machine. `tls: true` tells Vite the request
came over HTTPS (with the `x-forwarded-proto`, `x-forwarded-port` and `x-forwarded-ssl` headers), even
though the devtool talks to it in plain HTTP.

The name must lead to this machine: use the [local DNS](/configuration/network#the-local-dns), your own
DNS records, or `/etc/hosts`. For HTTPS, the load balancer needs a
[certificate](/configuration/certificates) for the domain.

## Where requests go: `target`

| `target` | Requests go to |
| --- | --- |
| `5173` | port 5173 of this machine |
| `192.168.1.20:8080` or `[::1]:8080` | that host and port, in plain HTTP |
| `https://192.168.1.20:8443/base` | that URL, in HTTPS, under `/base` |
| a list of the above | each target in turn |

```yaml [config.yml]
projects:
  api:
    services:
      api:
        hosts: [ api.example.dev, api.acme.example.dev ]
        target: [ 3000, 3001 ]
```

`hosts` lists several names for one service; with both, `hosts` wins over `host`. A list of targets
shares the requests between them in turn, handy to run two instances of a server.

## Several services on one host

`path`, `pathNot` and `prefix` split one host between several services.

```yaml [config.yml]
projects:
  web:
    services:
      web: { host: app.example.dev, target: 5173, pathNot: /api }
  api:
    services:
      api: { host: app.example.dev, target: 3000, path: /api, prefix: /api }
```

- `path` keeps the requests whose path starts with it. When several services match, the **longest**
  `path` wins.
- `pathNot` leaves out the requests whose path starts with it.
- `prefix` is removed from the path before forwarding: `/api/users` reaches the API as `/users`.

`preserveHost: true` forwards the original `Host` header (`app.example.dev`) instead of the host of the
target. Some frameworks need it to build absolute URLs.

## Who may connect: `access`

A service answers this machine only (`access: local`, the default). With `access: network`, other
devices of your network reach it too, such as a phone testing your site. See
[Network and DNS](/configuration/network).

## Open a service from the sidebar

A project can show a globe button that opens one of its hosts in a new tab, with the
[shortcut](/configuration/projects) `service:<slug>[:<index>]`. The index picks a host of `hosts`, `0` by
default.

```yaml [config.yml]
projects:
  api:
    services:
      api: { hosts: [ api.example.dev, docs.api.example.dev ], target: 3000 }
    icons: [ "service:api", "service:api:1" ]
```

## The load balancer

- It listens on [`adt.ports.loadBalancer`](/configuration/devtool) (6731 by default) on every network
  interface. Who may reach each host is decided per host, by `access`.
- Once at least one [certificate](/configuration/certificates) is declared, it serves HTTPS with HTTP/2,
  HTTP/1.1 for older clients, and WebSockets. Without certificate, it serves plain HTTP.
- Host names are matched exactly, in lower case.
- `devtool proxy` listens on port 443 of `127.0.0.1` and forwards to the load balancer, so
  `https://web.example.dev` works without a port on this machine. See the [CLI](/reference/cli).

::: tip The interface of the devtool itself
With [`adt.host`](/configuration/devtool), the load balancer also serves the interface of the devtool on
that host, following `adt.access`.
:::

::: warning `ports`, `urls` and `url` are gone
Older configurations used `ports`, `urls` or `url` in a service. The devtool ignores them with the
warning `is replaced by target: <port> | <host>:<port> | <URL>, or a list of them`. Write `target`
instead.
:::

## Reference

### `projects.<project>.services.<slug>`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `host` | string or list | | Host name served. |
| `hosts` | list | | Host names served; wins over `host`. |
| `target` | port, `host:port`, URL, or a list | required | Where requests go; a list is used in turn. |
| `tls` | boolean | `false` | Tell the target the request came over HTTPS. |
| `path` | string | | Only paths starting with it; the longest wins. |
| `pathNot` | string | | Leave out paths starting with it. |
| `prefix` | string | | Removed from the path before forwarding. |
| `preserveHost` | boolean | `false` | Forward the original `Host` header. |
| `access` | `local` or `network` | `local` | Who may connect. |

A target URL in `https://` is reached in HTTPS and implies `tls`.

### Warnings

- `host: must be a host name or a list of host names`.
- `target: <value> is not a port, <host>:<port> or http(s) URL`.
- `tls: is not a boolean`, `preserveHost: is not a boolean`: the service is dropped.
- `access: must be local or network, local is used`.
- `is replaced by target: ...`: a legacy `ports`, `urls` or `url` key.
