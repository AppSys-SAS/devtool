---
description: Decide who reaches your services, forward TLS untouched, and answer your own host names with the local DNS.
---

# Network and DNS

By default, everything the devtool serves is for this machine only. This page shows how to open a
service to the other devices of your network, how to let a tool keep its own certificate, and how the
local DNS gives your host names an address without touching `/etc/hosts`.

## Who may connect: `access`

`access` takes two values:

- `local` (the default): only this machine.
- `network`: any client that reaches this machine.

It applies to:

- each [service](/configuration/services), with its own `access`;
- the interface of the devtool served on [`adt.host`](/configuration/devtool), with `adt.access`;
- each `passthrough` rule and the local DNS, below.

```yaml [config.yml]
adt:
  host: devtool.example.dev
  access: local
projects:
  web:
    services:
      web: { host: web.example.dev, target: 5173, access: network }
```

The devtool decides from the address of the connection itself, never from a header such as
`x-forwarded-for`, so a client cannot pretend to be local.

::: tip The server and the interface stay local
The server of the devtool and its interface listen on `127.0.0.1` only. Only the load balancer and the
DNS listen on every interface, and they check `access` for each host.
:::

## Passthrough: let a tool keep its certificate

Some tools serve HTTPS with their own certificate, and break when another server terminates TLS in front
of them. A `passthrough` rule forwards their TLS connections untouched, chosen by the server name the
client asks for.

```yaml [config.local.yml]
passthrough:
  - { hosts: [ example.dev, "*.example.dev" ], target: "127.0.0.1:8443", access: local }
```

- `hosts` lists host names, or `*.<domain>` for every subdomain.
- `target` is `<host>:<port>` receiving the connections.
- Passthrough needs the load balancer to serve TLS: without any
  [certificate](/configuration/certificates), the rules are ignored (the log says so).

Passthrough rules are usually personal: keep them in `config.local.yml`.

## The local DNS

The local DNS answers the names you declare with an IPv4 address, and resolves every other name through
the system as usual. It saves every developer from editing `/etc/hosts`, and it is the only way to give
your names to a phone.

```yaml [config.yml]
dns:
  records:
    dev: { names: [ example.dev, "*.example.dev" ], address: 127.0.0.1 }
```

- `names` are host names, or `*.<domain>` for every subdomain.
- `address` is an IPv4 address, or `auto` for the current network address of this machine (the first
  one that is not internal). `auto` follows you when you change networks.
- `records` is a map, so `config.local.yml` can add its own names next to the shared ones.
- The DNS listens on port 53 (or `dns.port`), UDP and TCP, on every interface. `access` decides who may
  query it, `local` by default.
- It only starts with the load balancer, so not in the development mode of the devtool itself.

Point your system to it by adding `127.0.0.1` as a DNS server of your network settings, or with a
resolver file for your domain on macOS (`/etc/resolver/example.dev` holding `nameserver 127.0.0.1`).

::: warning An invalid port turns the DNS off
`dns.port` must be a port number. Otherwise the devtool warns `dns.port: must be a port number` and
does not start the DNS at all. The DNS is also off when no record is valid.
:::

## Reach your services from a phone

Say you want to try `https://web.example.dev` on a phone on the same Wi-Fi.

1. Open the service and the DNS to the network, and answer your names with the address of this
   machine:

   ```yaml [config.local.yml]
   dns:
     access: network
     records:
       dev: { names: [ example.dev, "*.example.dev" ], address: auto }
   projects:
     web:
       services:
         web: { host: web.example.dev, target: 5173, tls: true, access: network }
   ```

2. On the phone, set the DNS server of the Wi-Fi network to the address of this machine.
3. Open `https://web.example.dev:6731`, the port of the load balancer
   ([`adt.ports.loadBalancer`](/configuration/devtool)). `devtool proxy` only forwards port 443 for this
   machine; to drop the port on other devices too, set `adt.ports.loadBalancer: 443` where your system
   allows it.

The phone must trust the [certificate](/configuration/certificates): a certificate from a public
authority, such as one renewed with ACME, works out of the box.

## Reference

### `adt.access`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `adt.access` | `local` or `network` | `local` | Who may open the interface on `adt.host`. |

### `passthrough[]`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `hosts` | list | required | Host names or `*.<domain>`. |
| `target` | `<host>:<port>` | required | Where the TLS connections go, untouched. |
| `access` | `local` or `network` | `local` | Who may connect. |

### `dns`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `port` | number | `53` | Port of the DNS, UDP and TCP. |
| `access` | `local` or `network` | `local` | Who may query it. |
| `records.<slug>.names` | list | required | Host names or `*.<domain>`. |
| `records.<slug>.address` | IPv4 or `auto` | required | Address answered. |

### Warnings

- `passthrough: must be an array`.
- `passthrough[i].hosts: must be host names or *.<domain>`.
- `passthrough[i].target: must be <host>:<port>, the port between 1 and 65535`.
- `dns.records[<slug>].names: must be host names or *.<domain>`.
- `dns.records[<slug>].address: must be an IPv4 address or auto`.
- `dns.port: must be a port number`: the DNS is off.
- `access: must be local or network, local is used`.
