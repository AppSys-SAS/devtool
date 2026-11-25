---
description: Show web tools, pull requests and issues inside the devtool, and start coding agents on them.
---

# Integrations

An integration brings an outside tool into the devtool: a web page such as a mail catcher or a database
console, or the open pull requests and issues of a repository. Use them so you never leave the devtool to
check a mail, review a pull request or hand an issue to a coding agent.

```yaml [config.yml]
integrations:
  mail: { name: Mailpit, icon: mdi:email, url: "https://mail.example.dev" }
projects:
  web:
    integrations:
      pulls: { name: Pull requests, type: pullRequests, token: "{{ $(gh auth token) }}" }
    lines: [ integration:pulls ]
```

This adds a Mailpit page under Environment in the sidebar, and a Pull requests row under the `web` project.

## Where you declare them

An integration lives in one of three places, and that decides where it shows:

| Declared in | Shown in |
|---|---|
| `integrations` (root) | rows under Environment and Configs in the sidebar |
| `sections.<slug>.integrations` | the page of the section, and its header with `icons` and `lines` |
| `projects.<slug>.integrations` | the side panel of the project, and its row with `icons` and `lines` |

Pull requests and issues need a folder to work in, so they are refused at the root: declare them on a
section or a project.

## Web pages

A web integration needs a `name` and an http or https `url`. By default it opens inside the devtool, in a
frame. To let the page load there, the load balancer removes its `X-Frame-Options` header and sets
`frame-ancestors` to the devtool host. Set `embed: false` to open it in a new tab instead, which you need
for pages that are not served by your load balancer and refuse frames.

```yaml [config.yml]
sections:
  acme:
    integrations:
      grafana: { name: Grafana, icon: simple-icons:grafana, url: "https://grafana.example.dev" }
      docs: { name: Docs, url: "https://docs.example.com", embed: false }
    icons: [ integration:grafana ]
    lines: [ integration:docs ]
```

A section header only lists its own integrations in `icons` and `lines`. Projects can also show commands,
files and services there: see [Projects](/configuration/projects).

## Pull requests and issues

With `type: pullRequests` or `type: issues`, the integration lists the open pull requests or issues of a
repository. It works with GitHub (github.com and GitHub Enterprise Server) and GitLab.

1. **Repository.** `url` defaults to the `origin` remote of the folder of the section or project, so most
   of the time you leave it out. You can also give a web address or any remote form
   (`https://...`, `ssh://...`, `git@host:group/repo.git`).
2. **Forge.** `provider` is guessed from a host named `github.com`, `github.*`, `gitlab.com` or
   `gitlab.*`. For another host, set `provider: github` or `provider: gitlab`.
3. **Token.** GitHub always needs a `token`. GitLab reads the items of public projects without one, but not
   their timeline. The token is read with [value blocks](/configuration/automation), once per run of the
   server, and again after a change of the configuration or when the forge refuses it.

```yaml [config.yml]
projects:
  api:
    integrations:
      pulls: { name: Pull requests, type: pullRequests, token: "{{ $(gh auth token) }}" }
      issues: { name: Issues, type: issues, token: "{{ op://Dev/GitHub/token }}", refresh: 10 }
    lines: [ integration:pulls, integration:issues ]
```

### What you see

The list is read again every `refresh` minutes (5 by default) once an interface is open, and from its
Reload button. Set `refresh: 0` to read only from the button. You can filter it by Open, Review requested
(pull requests) or Assigned (issues), and Mine.

A click on a title opens the item in the devtool: labels, branches and checks or assignees, the
description, and the timeline, most recent first. The timeline holds comments, reviews with their
discussions on the code (file, line, excerpt, replies, resolved ones folded), commits grouped as pushed,
and changes of labels, assignees, title, state and references. The last 30 events are read when it opens;
**Load previous events** reads the others, up to 1000.

Markdown is shown with its HTML once sanitized: no scripts, no event handlers, no `javascript:` links.
Task lists show as read-only checkboxes and links open in a new tab.

With `badge` on (the default), the sidebar counts the pull requests waiting for your review, or the issues
assigned to you, next to the icon in `icons` and at the right of the row in `lines`.

::: warning GitLab limits
GitLab shows only running checks, read from the merge status of each merge request, and the devtool tells
its changes from its system notes. Without a token, the timeline of a GitLab item is not read.
:::

## Coding agents on pull requests and issues

Each integration can offer buttons that start a coding agent, in the folder of the section or project:

- `agentReview: true` on pull requests: a **Review** button.
- `agentAnalyze: true` on issues: analyze the issue and propose a plan, without changing any file.
- `agentFix: true` on issues: fix the issue on a branch of its own.

They are all off by default, because they start a program that can change your code. You also need at
least one agent in `adt.agents`:

```yaml [config.yml]
adt:
  agents:
    claude: { name: Claude Code, icon: simple-icons:claude, args: [ claude, "%{ADT:PROMPT}" ] }
projects:
  web:
    integrations:
      pulls: { name: Pull requests, type: pullRequests, token: "{{ $(gh auth token) }}", agentReview: true }
      issues: { name: Issues, type: issues, token: "{{ $(gh auth token) }}", agentAnalyze: true, agentFix: true }
    lines: [ integration:pulls, integration:issues ]
```

[Coding agents](/agents/coding-agents) shows how to declare Claude Code, Codex, Gemini CLI, Copilot,
Cursor and many other agents, and how to write your own prompts with `agentPrompts`.

## Reference

### Integration

`integrations.<slug>`, `sections.<slug>.integrations.<slug>`, `projects.<slug>.integrations.<slug>`

| Key | Type | Default | Description |
|---|---|---|---|
| `name` | string | required | Name shown in the sidebar and the pages. |
| `icon` | Iconify name | `lucide:app-window`, `lucide:git-pull-request`, `lucide:circle-dot` | Icon, `prefix:name`. |
| `type` | `web`, `pullRequests`, `issues` | `web` | What the integration shows. |
| `url` | string | origin remote (forges) | Web: required, the http(s) page. Forges: the repository. |
| `embed` | boolean | `true` | Web: show it inside the devtool. Always `false` for forges. |
| `provider` | `github`, `gitlab` | guessed | Forge of the repository. |
| `token` | string | none | Access token, read with value blocks. |
| `opAccount` | string | none | 1Password account used to read `op://` blocks of the token. |
| `refresh` | number | `5` | Minutes between two reads, `0` for the button only. |
| `badge` | boolean | `true` | Count the items waiting for you in the sidebar. |
| `agentReview` | boolean | `false` | Pull requests: Review button. |
| `agentAnalyze` | boolean | `false` | Issues: analyze button. |
| `agentFix` | boolean | `false` | Issues: fix button. |
| `agentPrompts` | map | none | `review`, or `analyze` and `fix`: prompts of this integration, see [Prompts](/agents/coding-agents#prompts). |
| `mcp` | level or levels | inherited | Forges: whether agents may read its items (`read`), see [Agent permissions](/configuration/mcp#from-general-to-precise). |

The agents and their prompts have their own [reference](/agents/coding-agents#reference).

### Warnings

The Server page shows these warnings, and the integration is left out:

- `must be a map of integrations`, `name: is not a string`
- `type: must be web or pullRequests or issues`
- `url: must be an http or https URL` (web)
- `<type> needs a section or a project, whose folder the agents work in` (forge at the root)
- `url: is missing and <path> has no origin remote`, `url: must name a repository`
- `provider: cannot be guessed from <host>, set one of github, gitlab`
- `refresh: must be a number of minutes, 0 to read on demand only`
- `agentFix: is not an action of pullRequests, which offer review` (the flag is ignored, the integration
  kept)

The warnings of `adt.agents` and `agentPrompts` are listed with the
[coding agents](/agents/coding-agents#warnings).
