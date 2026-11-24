# Security policy

The devtool runs commands, reads secrets through 1Password and exposes an MCP server to coding agents, so
we take security reports seriously.

## Development only

The devtool is made for the machine of a developer, to run a development environment. **Do not use it in
production**, and do not use it to serve anything to the public:

- it runs any command its configuration declares, with the rights of the user who started it;
- its load balancer and DNS are built for local development hosts, with certificates and settings meant
  for them, not for public traffic;
- its interface and its MCP server listen on this machine only and trust whoever reaches them there;
  `access: network` opens a service or the interface to your local network, never to the internet.

Keep production secrets, production databases and production hosts out of its configuration.

## Supported versions

Security fixes go to the latest release only. Update before reporting a problem.

## Report a vulnerability

Please do not open a public issue. Report it privately through
[GitHub Security Advisories](https://github.com/AppSys-SAS/devtool/security/advisories/new), with:

- what an attacker can do, and from where (this machine, the local network, a web page, an agent);
- the steps or the configuration that reproduce it;
- the version of the devtool and your operating system.

We answer within a few working days, keep you informed while we fix it, and credit you in the release
notes unless you prefer otherwise.
