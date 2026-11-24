---
description: Start Claude Code, Codex, Gemini CLI, Copilot, Cursor and other coding agents on a pull request or an issue, in the folder of the project.
---

:::: v-pre

# Coding agents

The [pull request and issue integrations](/configuration/integrations#pull-requests-and-issues) can hand an
item to a coding agent in one click: review this pull request, analyze this issue, fix it. You choose the
agents yourself in `adt.agents`: any command line agent that takes a prompt, or an application that opens
from a link. Claude Code, Codex, Gemini CLI, GitHub Copilot, Cursor, Mistral Vibe, Goose, Aider and many
more all work.

```yaml [config.yml]
adt:
  agents:
    claude: { name: Claude Code, icon: simple-icons:claude, args: [ claude, "%{ADT:PROMPT}" ] }
    codex: { name: Codex, icon: simple-icons:openai, args: [ codex, "%{ADT:PROMPT}" ] }
```

## How an agent runs

1. You turn on the buttons of an integration with `agentReview`, `agentAnalyze` or `agentFix` (see
   [Integrations](/configuration/integrations#coding-agents-on-pull-requests-and-issues)).
2. You click one of them on a pull request or an issue. The devtool writes the [prompt](#prompts) with the
   details of the item: its address, number, title, branches.
3. The button starts the agent you used last in this browser, or asks which one when there is none yet.
   Its arrow lists every agent, so you can switch at any time.
4. An agent with `args` runs in a new terminal of the project, in its folder. You follow it and talk to it
   there, as in your own terminal. An agent with `url` opens a link instead: a web page in a new tab, any
   other link in the application registered for it.

Two placeholders carry the details:

| Placeholder | Stands for |
|---|---|
| `%{ADT:PROMPT}` | the prompt of the button |
| `%{ADT:CWD}` | the folder of the project |

In `args`, each item stays one argument whatever it holds, so the prompt reaches the agent whole, quotes
and line breaks included. In a `url`, both are URL-encoded.

::: tip Let the agent run your project
An agent started by a button can also use the devtool through its [MCP server](/agents/mcp-server): run
the tests, start the dev server and read its logs while it reviews or fixes. Connect the agent once, at
user level, and install the [agent skills](/agents/skills).
:::

## Declare an agent

An agent needs a `name`, and either `args` or `url`. Add the buttons on an integration, and you are done:

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

- The slug (`claude` here) is made of letters, digits, `-`, `/`, `_` and `.`. Agents show in the order you
  declare them.
- `icon` is an Iconify name, `lucide:bot` by default.
- `args` run like a [command](/configuration/automation): `env`, `opAccount`, `unless`, `answers` and value
  blocks (`{{ op://... }}`, `{{ $(...) }}`, `{{ file://... }}`) all work, read when the agent starts. The
  text of a pull request or an issue is never read as value blocks.

## Agents by tool

Each line below starts the agent with the prompt. **Interactive** keeps the conversation open, so you can
answer the agent and ask for more. **One run** prints the answer in the terminal and exits.

| Agent | Interactive | One run |
|---|---|---|
| Claude Code | `claude "<prompt>"` | `claude -p "<prompt>"` |
| OpenAI Codex | `codex "<prompt>"` | `codex exec "<prompt>"` |
| Gemini CLI | `gemini -i "<prompt>"` | `gemini -p "<prompt>"` |
| GitHub Copilot CLI | `copilot -i "<prompt>"` | `copilot -p "<prompt>"` |
| Cursor CLI | `agent "<prompt>"` | `agent -p "<prompt>"` |
| Qwen Code | `qwen -i "<prompt>"` | `qwen -p "<prompt>"` |
| Mistral Vibe | `vibe "<prompt>"` | `vibe -p "<prompt>"` |
| Kiro CLI | `kiro-cli chat "<prompt>"` | `kiro-cli chat --no-interactive "<prompt>"` |
| Continue | `cn "<prompt>"` | `cn -p "<prompt>"` |
| JetBrains Junie | `junie --prompt "<prompt>"` | |
| Goose | `goose run -t "<prompt>" -s` | `goose run -t "<prompt>"` |
| Cline | `cline --auto-approve false "<prompt>"` | |
| Aider | | `aider -m "<prompt>"` |
| Amp | | `amp -x "<prompt>"` |
| Crush | | `crush run "<prompt>"` |
| OpenCode | | `opencode run "<prompt>"` |

Install them with their own installer or a package manager:

```bash
curl -fsSL https://claude.ai/install.sh | bash        # Claude Code, or: brew install --cask claude-code
npm install -g @openai/codex                         # Codex, or: brew install --cask codex
npm install -g @google/gemini-cli                    # Gemini CLI, or: brew install gemini-cli
npm install -g @github/copilot                       # GitHub Copilot CLI, or: brew install copilot-cli
curl https://cursor.com/install -fsS | bash          # Cursor CLI
npm install -g @qwen-code/qwen-code@latest           # Qwen Code, or: brew install qwen-code
curl -LsSf https://mistral.ai/vibe/install.sh | bash # Mistral Vibe, or: uv tool install --python 3.14 mistral-vibe
curl -fsSL https://cli.kiro.dev/install | bash       # Kiro CLI
npm i -g @continuedev/cli                            # Continue
curl -fsSL https://junie.jetbrains.com/install.sh | bash # Junie
brew install block-goose-cli                         # Goose
npm i -g @opencode/cli@latest                        # OpenCode
```

Claude Code also installs with `npm install -g @anthropic-ai/claude-code@latest`. For the others, follow
the documentation of the agent.

### Interactive agents

The agent starts on the prompt and the conversation stays open in the terminal: you answer its
questions, approve its changes and ask for more. This is the best fit for the fix button.

```yaml [config.yml]
adt:
  agents:
    claude: { name: Claude Code, icon: simple-icons:claude, args: [ claude, "%{ADT:PROMPT}" ] }
    codex: { name: Codex, icon: simple-icons:openai, args: [ codex, "%{ADT:PROMPT}" ] }
    gemini: { name: Gemini CLI, icon: simple-icons:googlegemini, args: [ gemini, -i, "%{ADT:PROMPT}" ] }
    copilot: { name: GitHub Copilot, icon: simple-icons:githubcopilot, args: [ copilot, -i, "%{ADT:PROMPT}" ] }
    cursor: { name: Cursor, icon: simple-icons:cursor, args: [ agent, "%{ADT:PROMPT}" ] }
    qwen: { name: Qwen Code, icon: simple-icons:qwen, args: [ qwen, -i, "%{ADT:PROMPT}" ] }
    vibe: { name: Mistral Vibe, icon: simple-icons:mistralai, args: [ vibe, "%{ADT:PROMPT}" ] }
    kiro: { name: Kiro, args: [ kiro-cli, chat, "%{ADT:PROMPT}" ] }
    continue: { name: Continue, args: [ cn, "%{ADT:PROMPT}" ] }
    junie: { name: Junie, icon: simple-icons:jetbrains, args: [ junie, --prompt, "%{ADT:PROMPT}" ] }
    goose: { name: Goose, args: [ goose, run, -t, "%{ADT:PROMPT}", -s ] }
    cline: { name: Cline, icon: simple-icons:cline, args: [ cline, --auto-approve, "false", "%{ADT:PROMPT}" ] }
```

A few agents need a flag to stay open after the first prompt:

- **Gemini CLI**, **Copilot** and **Qwen Code** take the first prompt with `-i` (`--prompt-interactive`
  for Gemini). Without it, `-p` runs once and exits.
- **Goose** keeps the session open with `-s`.
- **Junie** keeps its interface open after `--prompt`.
- **Cline** approves every action by itself when it gets a prompt. `--auto-approve false` keeps the
  approvals on; `-p` (`--plan`) makes it plan first.

### One run

The agent answers once and exits; the answer stays in the terminal. There is no conversation to go on
with, so keep these for reviews and analyses.

```yaml [config.yml]
adt:
  agents:
    claude-print: { name: Claude Code (one run), icon: simple-icons:claude, args: [ claude, -p, "%{ADT:PROMPT}" ] }
    codex-exec: { name: Codex (one run), icon: simple-icons:openai, args: [ codex, exec, "%{ADT:PROMPT}" ] }
    gemini-print: { name: Gemini CLI (one run), icon: simple-icons:googlegemini, args: [ gemini, -p, "%{ADT:PROMPT}" ] }
    copilot-print: { name: Copilot (one run), icon: simple-icons:githubcopilot, args: [ copilot, -p, "%{ADT:PROMPT}" ] }
    cursor-print: { name: Cursor (one run), icon: simple-icons:cursor, args: [ agent, -p, "%{ADT:PROMPT}" ] }
    kiro-print: { name: Kiro (one run), args: [ kiro-cli, chat, --no-interactive, "%{ADT:PROMPT}" ] }
    aider: { name: Aider, args: [ aider, -m, "%{ADT:PROMPT}" ] }
    amp: { name: Amp, args: [ amp, -x, "%{ADT:PROMPT}" ] }
    crush: { name: Crush, args: [ crush, run, "%{ADT:PROMPT}" ] }
    opencode: { name: OpenCode, icon: simple-icons:opencode, args: [ opencode, run, "%{ADT:PROMPT}" ] }
```

For Crush, use `crush run`: its `--prompt` option is not the prompt of the task.

## Variants

Nothing stops you from declaring the same agent several times with other options. They all show in the
arrow of the buttons.

### A read-only agent next to a fixer

Give the Review and analyze buttons an agent that cannot change any file, and keep a second one for fixes:

```yaml [config.yml]
adt:
  agents:
    claude-plan: { name: Claude Code (read-only), icon: simple-icons:claude, args: [ claude, --permission-mode, plan, "%{ADT:PROMPT}" ] }
    claude: { name: Claude Code, icon: simple-icons:claude, args: [ claude, "%{ADT:PROMPT}" ] }
    codex-read-only: { name: Codex (read-only), icon: simple-icons:openai, args: [ codex, -s, read-only, "%{ADT:PROMPT}" ] }
    gemini-plan: { name: Gemini CLI (plan), icon: simple-icons:googlegemini, args: [ gemini, --approval-mode, plan, -i, "%{ADT:PROMPT}" ] }
    copilot-plan: { name: Copilot (plan), icon: simple-icons:githubcopilot, args: [ copilot, --plan, -i, "%{ADT:PROMPT}" ] }
    cursor-plan: { name: Cursor (plan), icon: simple-icons:cursor, args: [ agent, --plan, "%{ADT:PROMPT}" ] }
```

| Agent | Read-only or plan mode |
|---|---|
| Claude Code | `--permission-mode plan` |
| Codex | `-s read-only` (`--sandbox`) |
| Gemini CLI | `--approval-mode plan` |
| GitHub Copilot CLI | `--plan`, or `--mode plan` |
| Cursor CLI | `--plan`, or `--mode plan`, `--mode ask` |
| Qwen Code | `--approval-mode plan` |
| Continue | `--readonly` |
| Junie | `--plan` |
| Cline | `-p` (`--plan`) |

The buttons share the agent used last: pick the read-only one from the arrow before a review, and the
fixer before a fix.

### Work in a separate worktree

A fix then happens in a worktree of its own, and your checkout stays as it was:

```yaml [config.yml]
adt:
  agents:
    claude-worktree: { name: Claude Code (worktree), icon: simple-icons:claude, args: [ claude, "%{ADT:PROMPT}", --worktree ] }
    copilot-worktree: { name: Copilot (worktree), icon: simple-icons:githubcopilot, args: [ copilot, -w, -i, "%{ADT:PROMPT}" ] }
    cursor-worktree: { name: Cursor (worktree), icon: simple-icons:cursor, args: [ agent, "%{ADT:PROMPT}", --worktree ] }
```

- The worktree option may take a name: keep it away from the prompt (last, or right before another
  option), so the prompt is not read as that name.
- Claude Code creates it in `.claude/worktrees/<name>` of the repository.
- Codex and Cline have `--worktree` too, and Mistral Vibe `--worktree <name>`. Gemini CLI has `-w` once
  its setting `experimental.worktrees` is `true`.

### Pick a model

```yaml [config.yml]
adt:
  agents:
    claude-opus: { name: Claude Code (Opus), icon: simple-icons:claude, args: [ claude, --model, opus, "%{ADT:PROMPT}" ] }
    codex-model: { name: Codex (GPT-5 Codex), icon: simple-icons:openai, args: [ codex, -m, gpt-5-codex, "%{ADT:PROMPT}" ] }
```

Model names change often: take one your agent lists. The option is `--model` for Claude Code, Copilot,
Cursor, Mistral Vibe, Kiro, Continue, Junie and Aider, and `-m` for Codex, Gemini CLI, Qwen Code and
Cline. Goose takes `--provider` and `--model`.

### API keys from your secrets

Read a key with a value block, at the moment the agent starts, instead of writing it in the
configuration or your shell profile:

```yaml [config.yml]
adt:
  agents:
    claude-api:
      name: Claude Code (API key)
      icon: simple-icons:claude
      args: [ claude, "%{ADT:PROMPT}" ]
      opAccount: my-team.1password.com
      env:
        ANTHROPIC_API_KEY: "{{ op://dev/anthropic/credential }}"
    gemini:
      name: Gemini CLI
      icon: simple-icons:googlegemini
      args: [ gemini, -i, "%{ADT:PROMPT}" ]
      env:
        GEMINI_API_KEY: "{{ file://.env#/GEMINI_API_KEY }}"
```

| Agent | Variable |
|---|---|
| Claude Code | `ANTHROPIC_API_KEY` |
| Gemini CLI | `GEMINI_API_KEY` |
| GitHub Copilot CLI | `COPILOT_GITHUB_TOKEN`, else `GH_TOKEN`, else `GITHUB_TOKEN` |
| Cursor CLI | `CURSOR_API_KEY` |
| Mistral Vibe | `MISTRAL_API_KEY` |
| Continue | `CONTINUE_API_KEY` |
| Amp | `AMP_API_KEY` |

The value is masked in the terminal, and only this agent gets it. An agent may prefer such a key over the
account you signed in with: set it only when you mean to use it.

### Local models

[Ollama](https://ollama.com) starts an agent on a model of your machine. `--yes` skips its pickers and
needs `--model`, and everything after `--` goes to the agent:

```yaml [config.yml]
adt:
  agents:
    ollama-claude:
      name: Claude Code (local)
      icon: simple-icons:ollama
      args: [ ollama, launch, claude, --model, qwen3-coder, --yes, --, "%{ADT:PROMPT}" ]
    aider-local:
      name: Aider (local)
      args: [ aider, --model, ollama_chat/qwen3-coder, -m, "%{ADT:PROMPT}" ]
      env:
        OLLAMA_API_BASE: http://127.0.0.1:11434
```

Replace `qwen3-coder` with a model you pulled.

### Trusted folders

Most agents ask whether you trust a folder the first time they work in it. The terminal shows the
question and you answer it once. To skip it, prefer the option of the agent:

- **Gemini CLI**: `--skip-trust`, or `GEMINI_CLI_TRUST_WORKSPACE: "true"` in `env`.
- **Mistral Vibe**: `--trust`, for this run only.
- **GitHub Copilot CLI**: the folders listed in `trustedFolders` of `~/.copilot/config.json`.
- **Junie**: the `JUNIE_TRUST_PROJECT` variable, see the documentation of Junie.
- **Claude Code** asks in its workspace trust dialog, for each new folder.

```yaml [config.yml]
adt:
  agents:
    gemini: { name: Gemini CLI, icon: simple-icons:googlegemini, args: [ gemini, --skip-trust, -i, "%{ADT:PROMPT}" ] }
    vibe: { name: Mistral Vibe, icon: simple-icons:mistralai, args: [ vibe, --trust, "%{ADT:PROMPT}" ] }
```

For an agent without such an option, `answers` can type the reply. The text of the question differs from
one agent and version to the next, so read what yours prints first, then copy a few of its words into
`match`. An empty `value` presses Enter alone, which picks the choice already highlighted. This one is an
example to adapt, for an agent named `my-agent`:

```yaml [config.yml]
adt:
  agents:
    my-agent:
      name: My agent
      args: [ my-agent, "%{ADT:PROMPT}" ]
      answers:
        - { match: "trust this folder", value: "" }
```

An answer waits until its question shows up. If the folder is already trusted, it stays armed and types
on the first later output that matches: make `match` precise enough to only fit the question.

## Open an application instead

With `url`, the button opens a link in place of a terminal. A link to an application prefills its
prompt; you still read it and send it yourself.

```yaml [config.yml]
adt:
  agents:
    claude-desktop: { name: Claude Desktop, icon: simple-icons:claude, url: "claude://code/new?folder=%{ADT:CWD}&q=%{ADT:PROMPT}" }
    claude-terminal: { name: Claude Code (terminal app), icon: simple-icons:claude, url: "claude-cli://open?q=%{ADT:PROMPT}&cwd=%{ADT:CWD}" }
    claude-vscode: { name: Claude in VS Code, icon: simple-icons:visualstudiocode, url: "vscode://anthropic.claude-code/open?prompt=%{ADT:PROMPT}" }
    codex-app: { name: Codex app, icon: simple-icons:openai, url: "codex://new?prompt=%{ADT:PROMPT}&path=%{ADT:CWD}" }
    cursor-app: { name: Cursor, icon: simple-icons:cursor, url: "cursor://anysphere.cursor-deeplink/prompt?text=%{ADT:PROMPT}" }
    vscode-agent: { name: VS Code agent, icon: simple-icons:visualstudiocode, url: "vscode://agents/new?prompt=%{ADT:PROMPT}" }
```

| Application | Link | Notes |
|---|---|---|
| Claude Desktop | `claude://code/new?folder=%{ADT:CWD}&q=%{ADT:PROMPT}` | The app always asks you to confirm the folder. |
| Claude Code in a terminal | `claude-cli://open?q=%{ADT:PROMPT}&cwd=%{ADT:CWD}` | Registered after a first interactive session of Claude Code. The prompt is limited to 5000 characters. |
| Claude in VS Code | `vscode://anthropic.claude-code/open?prompt=%{ADT:PROMPT}` | |
| Codex app | `codex://new?prompt=%{ADT:PROMPT}&path=%{ADT:CWD}` | |
| Cursor | `cursor://anysphere.cursor-deeplink/prompt?text=%{ADT:PROMPT}` | At most 10 000 characters once encoded. |
| VS Code agents | `vscode://agents/new?prompt=%{ADT:PROMPT}` | |

A web address (`https://...`) opens in a new tab.

## Prompts

Each button has a built-in prompt. You can replace it at two levels, the most precise one winning:

1. `agentPrompts` on the integration (`review`, or `analyze` and `fix`);
2. `adt.agentPrompts.pullRequests.review`, `adt.agentPrompts.issues.analyze` and
   `adt.agentPrompts.issues.fix`, for every integration;
3. the built-in prompt.

```yaml [config.yml]
adt:
  agentPrompts:
    issues: { analyze: "Analyze %{ADT:ISSUE_URL} and list the files involved." }
    pullRequests: { review: "Review %{ADT:PR_URL} (%{ADT:PR_BRANCH} into %{ADT:PR_BASE}) and comment on risky changes." }
projects:
  web:
    integrations:
      issues:
        name: Issues
        type: issues
        token: "{{ $(gh auth token) }}"
        agentFix: true
        agentPrompts:
          fix: "Fix %{ADT:ISSUE_URL} on a branch named issue-%{ADT:ISSUE_NUMBER}, then run the tests."
```

| Variable | Stands for |
|---|---|
| `%{ADT:PR_URL}` | web address of the pull request |
| `%{ADT:PR_NUMBER}` | its number |
| `%{ADT:PR_TITLE}` | its title |
| `%{ADT:PR_BRANCH}` | its branch |
| `%{ADT:PR_BASE}` | the branch it merges into |
| `%{ADT:PR_AUTHOR}` | its author |
| `%{ADT:ISSUE_URL}` | web address of the issue |
| `%{ADT:ISSUE_NUMBER}` | its number |
| `%{ADT:ISSUE_TITLE}` | its title |
| `%{ADT:ISSUE_AUTHOR}` | its author |

The built-in prompts ask the review to read the changes without checking out the branch, the analysis to
change no file, and the fix to work on a branch named after the issue.

::: warning Keep the approvals on
Options such as `--dangerously-skip-permissions`, `--yolo`, `--permission-mode bypassPermissions` or
`-a never` let the agent change files and run commands without asking you. The prompt holds text written
by others, such as the title of a pull request or an issue, and the agent reads the rest of the item on
its own. Keep the approvals of your agent on.
:::

## Reference

### Agent

`adt.agents.<slug>`, the slug made of letters, digits, `-`, `/`, `_` and `.`.

| Key | Type | Default | Description |
|---|---|---|---|
| `name` | string | required | Name shown in the agent menu. |
| `icon` | Iconify name | `lucide:bot` | Icon of the agent. |
| `args` | list of strings | none | Run in a terminal of the project. Give `args` or `url`. |
| `url` | string | none | Opened by the browser. Give `args` or `url`. |
| `env` | map or list of maps | none | Environment of `args`, value blocks read. |
| `opAccount`, `unless`, `answers` | | | As in [commands](/configuration/automation). |

### Prompts

| Key | Type | Description |
|---|---|---|
| `adt.agentPrompts.pullRequests.review` | string | Prompt of the Review button. |
| `adt.agentPrompts.issues.analyze` | string | Prompt of the analyze button. |
| `adt.agentPrompts.issues.fix` | string | Prompt of the fix button. |
| `<integration>.agentPrompts.review`, `.analyze`, `.fix` | string | Prompts of one integration. |

### Warnings

The Server page shows these warnings, and the agent or prompt is left out:

- `adt.agents: must be a map of agents`
- `adt.agents.<slug>: is not a slug (a-z0-9-/_.)`, `adt.agents.<slug>.name: is not a string`
- `adt.agents.<slug>: needs either args, run in a terminal, or url, opened by the interface`
- `adt.agents.<slug>.args: must be a non-empty array of strings or numbers`
- `adt.agentPrompts: must be a map of prompts by kind of integration`
- `adt.agentPrompts.<kind>: is not a kind of integration, expected pullRequests or issues`
- `<prompts>: must be a map of prompts by action`
- `<prompts>.<action>: is not an action of <kind>, which offer <actions>`

::::
