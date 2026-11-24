---
description: Serve HTTPS with your own certificates, and let the devtool renew them with ACME or your own command.
---

# Certificates

The load balancer serves HTTPS once it has a certificate. You declare one per domain under
`loadBalancers`, and it covers the domain and all its subdomains. The devtool can then renew it for you,
with [lego](https://go-acme.github.io/lego/) and any ACME authority such as Let's Encrypt, or with a
command of your own.

A real certificate for a domain you own is the simplest way to get HTTPS that every browser and phone
trusts, without installing a local authority.

## A first certificate

```yaml [config.yml]
loadBalancers:
  example.dev:
    crt: certs/example.dev.crt
    key: certs/example.dev.key
```

- The name, `example.dev`, is the domain. The certificate is used for `example.dev` and every name
  ending in `.example.dev`, as long as the certificate itself covers them.
- `crt` and `key` are files, relative to the configuration folder, or the PEM text itself.
- The first certificate declared is the default one, served when no domain matches.
- Declaring a certificate turns the load balancer to HTTPS, with HTTP/2.

The Server page lists the certificates with their expiry date. From `warn` days before the expiry (30 by
default) it shows a warning.

## Renew with ACME

Add `acme` to let the devtool renew the certificate. It runs `lego` with a DNS challenge, so it works on
a laptop that no ACME server can reach.

```yaml [config.yml]
loadBalancers:
  example.dev:
    crt: certs/example.dev.crt
    key: certs/example.dev.key
    acme:
      trigger: both
      before: 30
      opAccount: my-team.1password.com
      env: { CF_DNS_API_TOKEN: "{{ op://Engineering/Cloudflare/token }}" }
      lego:
        domains: [ example.dev, "*.example.dev" ]
        email: certs@example.dev
        dns: cloudflare
```

- `lego` holds the options of `lego run`, written without their dashes: `email: x` gives `--email x`, a
  list repeats the option, `true` gives it alone, `false` leaves it out.
- `env` gives lego and its DNS provider their variables. [Value blocks](/configuration/automation) are
  read, so the token stays in 1Password.
- The devtool sets `path`, `cert.name`, `accept-tos`, `renew-force`, `renew-days` and `no-random-sleep`
  itself: you cannot set them.

The devtool runs lego `5.6.0`. It downloads it from the lego releases the first time a certificate is
renewed, checks its checksum, and keeps it in the [cache folder](/configuration/devtool) with the ACME
account and certificates. macOS and Linux are supported, on arm64 and x64. A newer devtool installs its
own version and removes the older ones.

### When it renews: `trigger`

| `trigger` | Renews |
| --- | --- |
| `button` (default) | From the Server page, forced even when not due. |
| `auto` | When the server starts, then twice a day once the certificate expires within `before` days, at most once a day. |
| `both` | Both. |

From a terminal, `devtool cert renew` renews every certificate, and `devtool cert renew example.dev`
only the ones you name. See the [CLI](/reference/cli).

The load balancer serves the new certificate right away, without a restart.

::: tip Share the renewed certificate with the team
When `crt` and `key` are [synchronized files of the environment](/configuration/environment), the
Server page offers to push them to their backend after a renewal. Your teammates then get the new certificate
with their next pull.
:::

## Renew with your own command

Any tool can renew the certificate: give `command` instead of `lego`. It runs in the folder of the
certificate, and must write the certificate and its key at the paths it receives.

```yaml [config.yml]
loadBalancers:
  example.dev:
    crt: certs/example.dev.crt
    key: certs/example.dev.key
    acme:
      command: [ ./renew.sh, "%{ADT:CRT}", "%{ADT:KEY}" ]
```

`%{ADT:CRT}` and `%{ADT:KEY}` stand for the paths of `crt` and `key`. `unless` and `answers` work as in
[commands](/configuration/automation).

::: warning ACME needs files
Renewal writes files: `crt` and `key` must be files, not PEM texts. Otherwise the devtool warns
`needs crt and key to be files, not PEM texts` and ignores `acme`.
:::

## When the Server page warns

- A certificate renewed by its button, or not renewed at all, warns from `warn` days before its expiry.
- A certificate renewed on its own (`auto` or `both`) warns from `before` days, once its automatic
  renewal should already have happened.

## Reference

### `loadBalancers.<domain>`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `crt` | path or PEM | required | The certificate. |
| `key` | path or PEM | required | Its private key. |
| `warn` | days | `30` | When the Server page starts to warn. |
| `acme` | map | | Renewal, below. |
| `mcp` | level or levels | inherited | What agents may do, see [Agent permissions](/configuration/mcp). |

### `loadBalancers.<domain>.acme`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `trigger` | `button`, `auto` or `both` | `button` | How renewals start. |
| `before` | days | `30` | How early `auto` renews. |
| `lego` | map | | Options of `lego run`, without dashes. Either `lego` or `command`. |
| `command` | list | | Your renewal command. Either `lego` or `command`. |
| `env` | map | | Variables of the renewal, value blocks read. |
| `opAccount`, `unless`, `answers` | | | See [Automation and secrets](/configuration/automation). |

### Warnings

- `loadBalancers[<domain>].crt: is not a string`: the certificate is skipped.
- `warn: must be a positive number of days`, `before: must be a positive number of days`.
- `acme: needs crt and key to be files, not PEM texts`.
- `acme: needs either lego or command`.
- `acme.trigger: must be button, auto or both`.
- `acme.lego.<option>: is set by the devtool`.
- `acme.lego.<option>: must be a string, a number, a boolean or a list of strings or numbers`.
