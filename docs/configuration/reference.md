---
description: Every key of the devtool configuration, with its type, its default and the page that explains it.
---

# All keys

Every key the devtool reads, grouped by top-level key. `<slug>` stands for a name you choose. Follow the
links for explanations and examples.

The same keys are described by a JSON Schema, which gives completion and checks in your editor: add this
first line to your configuration files.

```yaml [config.yml]
# yaml-language-server: $schema=https://appsys-sas.github.io/devtool/schema/config.json
workspace: ~/Workspace
```

The schema is also published with the npm package, as `@appsys/devtool-config/schema/config.schema.json`.

## Root

| Key | Type | Default | Page |
|---|---|---|---|
| `workspace` | string | none | [Files and merging](/configuration/overview) |
| `sectionPath` | string | `.` | [Files and merging](/configuration/overview) |
| `include` | list of strings | none | [Files and merging](/configuration/overview) |
| `adt` | map | | [The devtool](/configuration/devtool) |
| `sections` | map | | [Sections](/configuration/sections) |
| `projects` | map | | [Projects](/configuration/projects) |
| `integrations` | map | | [Integrations](/configuration/integrations) |
| `loadBalancers` | map | | [Certificates](/configuration/certificates) |
| `passthrough` | list | | [Network and DNS](/configuration/network) |
| `dns` | map | | [Network and DNS](/configuration/network) |
| `environment` | map | | [Environment](/configuration/environment) |
| `auth` | map | | [Sign-in](/configuration/auth) |

## adt

| Key | Type | Default | Page |
|---|---|---|---|
| `adt.displayName` | string | `AppSys Devtool` | [The devtool](/configuration/devtool) |
| `adt.name` | string | display name in lowercase | [The devtool](/configuration/devtool) |
| `adt.icon` | path | none | [The devtool](/configuration/devtool) |
| `adt.cacheDir` | path | `~/.cache/appsys/devtool` | [The devtool](/configuration/devtool) |
| `adt.host` | string | none | [The devtool](/configuration/devtool) |
| `adt.access` | `local`, `network` | `local` | [Network and DNS](/configuration/network) |
| `adt.ports.server` | integer | `6730` | [The devtool](/configuration/devtool) |
| `adt.ports.loadBalancer` | integer | `6731` | [The devtool](/configuration/devtool) |
| `adt.shell` | string | `$SHELL` | [The devtool](/configuration/devtool) |
| `adt.notifications` | boolean | `true` | [The devtool](/configuration/devtool) |
| `adt.sidebar.environment` | boolean | `false` | [The devtool](/configuration/devtool) |
| `adt.sidebar.configs` | boolean | `false` | [The devtool](/configuration/devtool) |
| `adt.sidebar.login` | boolean | `false` | [The devtool](/configuration/devtool) |
| `adt.sidebar.sort` | `config`, `name`, `manual` | `config` | [The devtool](/configuration/devtool) |
| `adt.sidebar.order` | list of section slugs | none | [The devtool](/configuration/devtool) |
| `adt.agents.<slug>.name` | string | required | [Coding agents](/agents/coding-agents#declare-an-agent) |
| `adt.agents.<slug>.icon` | Iconify name | `lucide:bot` | [Coding agents](/agents/coding-agents#declare-an-agent) |
| `adt.agents.<slug>.args` | list | none | [Coding agents](/agents/coding-agents#agents-by-tool) |
| `adt.agents.<slug>.url` | string | none | [Coding agents](/agents/coding-agents#open-an-application-instead) |
| `adt.agents.<slug>.env` | map or list of maps | none | [Coding agents](/agents/coding-agents#api-keys-from-your-secrets) |
| `adt.agents.<slug>.opAccount`, `.unless`, `.answers` | | | [Automation](/configuration/automation) |
| `adt.agentPrompts.pullRequests.review` | string | built-in | [Coding agents](/agents/coding-agents#prompts) |
| `adt.agentPrompts.issues.analyze` | string | built-in | [Coding agents](/agents/coding-agents#prompts) |
| `adt.agentPrompts.issues.fix` | string | built-in | [Coding agents](/agents/coding-agents#prompts) |
| `adt.mcp.enabled` | boolean | `false` | [Agent permissions](/configuration/mcp) |
| `adt.mcp.notifications` | boolean | `adt.notifications` | [Agent permissions](/configuration/mcp) |
| `adt.mcp.skills` | boolean | `true` | [Agent skills](/agents/skills#serve-them-over-mcp) |
| `adt.mcp.timeout` | integer | `120` | [Agent permissions](/configuration/mcp) |
| `adt.mcp.ownTerminals` | `allow`, `ask` | `allow` | [Agent permissions](/configuration/mcp#agents-and-shell-commands) |
| `adt.mcp.default` | rules | read allow, others ask | [Agent permissions](/configuration/mcp#from-general-to-precise) |
| `adt.mcp.commands`, `.scripts`, `.files`, `.terminals`, `.certificates`, `.devtool`, `.integrations` | rules | `adt.mcp.default` | [Agent permissions](/configuration/mcp#from-general-to-precise) |
| `adt.mcp.clients.level`, `.allow`, `.deny` | level, lists | `ask` | [Agent permissions](/configuration/mcp#agents-and-shell-commands) |
| `adt.mcp.shell.level`, `.allow`, `.deny` | level, lists | `deny` | [Agent permissions](/configuration/mcp#agents-and-shell-commands) |

## sections.&lt;slug&gt;

| Key | Type | Default | Page |
|---|---|---|---|
| `name` | string | the slug | [Sections](/configuration/sections) |
| `description` | string | none | [Sections](/configuration/sections) |
| `path` | string | `sectionPath` | [Sections](/configuration/sections) |
| `restore.name`, `restore.args` | string, list | `Restore` | [Sections](/configuration/sections) |
| `notifications` | boolean | `adt.notifications` | [Sections](/configuration/sections) |
| `mcp` | rules | `adt.mcp.default` | [Agent permissions](/configuration/mcp) |
| `integrations.<slug>` | map | | [Integrations](/configuration/integrations) |
| `icons`, `lines` | list of `integration:<slug>` | none | [Sections](/configuration/sections) |
| `sort` | `config`, `name`, `manual` | `adt.sidebar.sort` | [Sections](/configuration/sections) |
| `order` | list | none | [Sections](/configuration/sections) |
| `meta.icon` | Iconify name | `lucide:folder-tree` | [Sections](/configuration/sections) |

## projects.&lt;slug&gt;

| Key | Type | Default | Page |
|---|---|---|---|
| `section` | section slug | `uncategorized` | [Projects](/configuration/projects) |
| `name` | string | the slug | [Projects](/configuration/projects) |
| `description` | string | none | [Projects](/configuration/projects) |
| `path` | string | the slug | [Projects](/configuration/projects) |
| `restore.name`, `restore.args` | string, list | `Restore` | [Projects](/configuration/projects) |
| `notifications` | boolean | section | [Projects](/configuration/projects) |
| `env` | map or list of maps | none | [Projects](/configuration/projects) |
| `shell` | string | `adt.shell` | [Projects](/configuration/projects) |
| `killSignal` | string | `SIGTERM` | [Projects](/configuration/projects) |
| `mcp` | rules | section | [Agent permissions](/configuration/mcp) |
| `default.action` | shortcut | none | [Projects](/configuration/projects) |
| `default.trigger` | `icon`, `row`, `row-icon` | `icon` | [Projects](/configuration/projects) |
| `default.icon` | `own` or Iconify name | by type | [Projects](/configuration/projects) |
| `icons`, `lines` | list of shortcuts | none | [Projects](/configuration/projects) |
| `meta.icon` | Iconify name | `lucide:folder-tree` | [Projects](/configuration/projects) |
| `commands.<slug>.name` | string | the slug | [Commands and scripts](/configuration/commands) |
| `commands.<slug>.args` | list of strings, numbers, inputs | required | [Commands and scripts](/configuration/commands) |
| `commands.<slug>.env` | map or list of maps | none | [Commands and scripts](/configuration/commands) |
| `commands.<slug>.shell` | string | project | [Commands and scripts](/configuration/commands) |
| `commands.<slug>.killSignal` | string | `SIGTERM` | [Commands and scripts](/configuration/commands) |
| `commands.<slug>.detached` | boolean | `false` | [Commands and scripts](/configuration/commands) |
| `commands.<slug>.prompt` | boolean | `false` | [Commands and scripts](/configuration/commands) |
| `commands.<slug>.startWithSection` | boolean | `false` | [Commands and scripts](/configuration/commands) |
| `commands.<slug>.form` | `dialog`, `inline` | `dialog` | [Commands and scripts](/configuration/commands) |
| `commands.<slug>.notifications` | boolean | project | [Commands and scripts](/configuration/commands) |
| `commands.<slug>.opAccount`, `.unless`, `.answers` | | | [Automation](/configuration/automation) |
| `commands.<slug>.mcp` | rules | `adt.mcp.commands` | [Agent permissions](/configuration/mcp) |
| `commands.<slug>.meta.icon` | Iconify name | `ph:terminal` | [Commands and scripts](/configuration/commands) |
| `scripts[]` | path or map | none | [Commands and scripts](/configuration/commands) |
| `scripts[].path`, `.prompt`, `.form`, `.only`, `.mcp` | | `form: inline` | [Commands and scripts](/configuration/commands) |
| `scripts[].scripts.<file>.prompt`, `.args`, `.form`, `.mcp` | | | [Commands and scripts](/configuration/commands) |
| `services.<slug>.host`, `.hosts` | string or list | required | [Services](/configuration/services) |
| `services.<slug>.target` | port, `host:port`, URL or list | required | [Services](/configuration/services) |
| `services.<slug>.tls`, `.preserveHost` | boolean | `false` | [Services](/configuration/services) |
| `services.<slug>.path`, `.pathNot`, `.prefix` | string | none | [Services](/configuration/services) |
| `services.<slug>.access` | `local`, `network` | `local` | [Services](/configuration/services) |
| `files.<slug>.name` | string | the slug | [Files](/configuration/files) |
| `files.<slug>.path` | string | required | [Files](/configuration/files) |
| `files.<slug>.type` | `files`, `agentSkills` | `files` | [Files](/configuration/files) |
| `files.<slug>.restore` | command slug | none | [Files](/configuration/files) |
| `files.<slug>.commands` | list of command slugs | none | [Files](/configuration/files) |
| `files.<slug>.mcp` | rules | `adt.mcp.files` | [Agent permissions](/configuration/mcp) |
| `files.<slug>.showHidden` | boolean | `false` | [Files](/configuration/files#reference) |
| `files.<slug>.mcpSkills` | `true`, list of globs | `false` | [Agent skills](/agents/skills#serve-them-over-mcp) |
| `integrations.<slug>` | map | | [Integrations](/configuration/integrations) |

## integrations.&lt;slug&gt;

Also under `sections.<slug>.integrations` and `projects.<slug>.integrations`.

| Key | Type | Default | Page |
|---|---|---|---|
| `name` | string | required | [Integrations](/configuration/integrations#integration) |
| `icon` | Iconify name | by type | [Integrations](/configuration/integrations#integration) |
| `type` | `web`, `pullRequests`, `issues` | `web` | [Integrations](/configuration/integrations#integration) |
| `url` | string | origin remote for forges | [Integrations](/configuration/integrations#integration) |
| `embed` | boolean | `true` | [Integrations](/configuration/integrations#web-pages) |
| `provider` | `github`, `gitlab` | guessed | [Integrations](/configuration/integrations#pull-requests-and-issues) |
| `token`, `opAccount` | string | none | [Integrations](/configuration/integrations#pull-requests-and-issues) |
| `refresh` | number | `5` | [Integrations](/configuration/integrations#what-you-see) |
| `badge` | boolean | `true` | [Integrations](/configuration/integrations#what-you-see) |
| `agentReview`, `agentAnalyze`, `agentFix` | boolean | `false` | [Integrations](/configuration/integrations#coding-agents-on-pull-requests-and-issues) |
| `agentPrompts.review`, `.analyze`, `.fix` | string | `adt.agentPrompts` | [Coding agents](/agents/coding-agents#prompts) |

## loadBalancers.&lt;domain&gt;

| Key | Type | Default | Page |
|---|---|---|---|
| `crt`, `key` | path or PEM | required | [Certificates](/configuration/certificates) |
| `warn` | integer | `30` | [Certificates](/configuration/certificates) |
| `mcp` | rules | `adt.mcp.certificates` | [Agent permissions](/configuration/mcp) |
| `acme.trigger` | `button`, `auto`, `both` | `button` | [Certificates](/configuration/certificates) |
| `acme.before` | integer | `30` | [Certificates](/configuration/certificates) |
| `acme.lego.<option>` | value, boolean or list | none | [Certificates](/configuration/certificates) |
| `acme.command` | list | none | [Certificates](/configuration/certificates) |
| `acme.env` | map | none | [Certificates](/configuration/certificates) |
| `acme.opAccount`, `.unless`, `.answers` | | | [Automation](/configuration/automation) |

## passthrough[] and dns

| Key | Type | Default | Page |
|---|---|---|---|
| `passthrough[].hosts` | list of hosts or `*.<domain>` | required | [Network and DNS](/configuration/network) |
| `passthrough[].target` | `host:port` | required | [Network and DNS](/configuration/network) |
| `passthrough[].access` | `local`, `network` | `local` | [Network and DNS](/configuration/network) |
| `dns.enabled` | boolean | `true` | [Network and DNS](/configuration/network#turn-it-off-or-move-it) |
| `dns.port` | integer | `53` | [Network and DNS](/configuration/network) |
| `dns.access` | `local`, `network` | `local` | [Network and DNS](/configuration/network) |
| `dns.upstream` | `<host>[:<port>]` | the system | [Network and DNS](/configuration/network#chain-several-devtools) |
| `dns.records.<slug>.names` | list of hosts or `*.<domain>` | required | [Network and DNS](/configuration/network) |
| `dns.records.<slug>.address` | IPv4 or `auto` | required | [Network and DNS](/configuration/network) |

## environment

| Key | Type | Default | Page |
|---|---|---|---|
| `environment.folder` | path | parent of the configuration folder | [Environment](/configuration/environment#the-environment-folder) |
| `environment.backends.<name>.type` | `cdn`, `s3`, `sftp`, `git`, `scripts` | required | [Backends](/configuration/backends) |
| `environment.backends.<name>.default` | boolean | `false` | [Backends](/configuration/backends#the-default-backend) |
| `environment.backends.<name>.encryption` | `{ key }`, `{ password }`, `{ prompt: true }` | none | [Encryption](/configuration/encryption) |
| `environment.backends.<name>.url` (cdn) | string | required | [CDN](/configuration/cdn) |
| `environment.backends.<name>.bucket`, `.prefix`, `.endpoint`, `.region`, `.accessKeyId`, `.secretAccessKey`, `.pathStyle` (s3) | | `bucket` required | [Backends](/configuration/backends#s3) |
| `environment.backends.<name>.host`, `.port`, `.username`, `.path`, `.privateKey`, `.passphrase`, `.password` (sftp) | | `host`, `username` required | [Backends](/configuration/backends#sftp) |
| `environment.backends.<name>.url`, `.branch`, `.path` (git) | | `url` required | [Backends](/configuration/backends#git) |
| `environment.backends.<name>.list`, `.download`, `.upload`, `.remove`, `.cwd`, `.env` (scripts) | | commands required | [Backends](/configuration/backends#scripts) |
| `environment.encryption[].paths` | list of globs | required | [Encryption](/configuration/encryption#encrypt-files-by-path) |
| `environment.encryption[].key`, `.password`, `.prompt` | | one required | [Encryption](/configuration/encryption#encrypt-files-by-path) |
| `environment.mcp` | rules | `adt.mcp.default` | [Agent permissions](/configuration/mcp) |
| `environment.files[]` | path or map | none | [Environment](/configuration/environment#files) |
| `environment.files[].path`, `.display`, `.local`, `.sync` | | `true` | [Environment](/configuration/environment#files) |
| `environment.files[].ignore` | list of key paths | none | [Environment](/configuration/environment#ignored-keys) |
| `environment.databases[].path`, `.engine`, `.container` | | required | [Environment](/configuration/environment#databases) |
| `environment.buckets[].path`, `.bucket` | | required | [Environment](/configuration/environment#buckets-and-s3) |
| `environment.redis[].path`, `.url` | | required | [Environment](/configuration/environment#redis) |
| `environment.<list>[].pull.cron`, `.pull.startup` | string, boolean | none | [Environment](/configuration/environment#pull-on-a-schedule) |
| `environment.<list>[].backend` | string | the default backend | [Backends](/configuration/backends#choose-the-backend-of-an-item) |
| `environment.<list>[].encryption` | `{ key }`, `{ password }`, `{ prompt: true }` | `environment.encryption` | [Encryption](/configuration/encryption) |
| `environment.<list>[].mcp` | rules | `environment.mcp` | [Agent permissions](/configuration/mcp) |
| `environment.s3.endpoint`, `.accessKeyId`, `.secretAccessKey` | string | required | [Environment](/configuration/environment#buckets-and-s3) |
| `environment.s3.region` | string | `us-east-1` | [Environment](/configuration/environment#buckets-and-s3) |

## auth

| Key | Type | Default | Page |
|---|---|---|---|
| `auth.type` | `openid` | `openid` | [Sign-in](/configuration/auth) |
| `auth.name` | string | none | [Sign-in](/configuration/auth) |
| `auth.issuer` | string | required | [Sign-in](/configuration/auth) |
| `auth.clientId` | string | required | [Sign-in](/configuration/auth) |
| `auth.callbackPort` | integer | `6732` | [Sign-in](/configuration/auth) |
| `auth.scopes` | list of strings | `[ openid, offline_access, groups, profile ]` | [Sign-in](/configuration/auth#scopes) |
