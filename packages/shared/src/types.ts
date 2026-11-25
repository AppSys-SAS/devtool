/** Who reaches a host through the load balancer: clients of this machine only, or any client. */
export type HostAccess = 'local' | 'network'

export interface AdtDefinition {
  /** The identifier of the devtool, such as the name of its MCP server. */
  name: string
  /** The name shown to people, such as the name of its app and of its interface. */
  displayName: string
  /** The image of its icon, null for the default one. */
  icon: string | null
  host: string | null
  /** The interface, from the startup options only: a folder of static files or the URL of a server. */
  uiPath?: string
  /** Folder of the files the devtool rebuilds or keeps between runs, given to the commands as `APPSYS_DEVTOOL_CACHE_DIR`. */
  cacheDir: string
  shell: string | null
  ports: {
    server: number
    loadBalancer: number
  }
  notifications: boolean
  /** Who reaches the interface of the devtool. */
  access: HostAccess
  sidebar: SidebarSettings
  /** What agents may do through the MCP server of the devtool. */
  mcp: McpSettings
  /** The AI agents the interface starts, in the order of the configuration. */
  agents: AgentDefinition[]
}

/** How an agent may do something: freely, after asking, on the keys of a file only, or never. */
export type McpLevel = 'allow' | 'ask' | 'keys' | 'deny'

/** What an agent does: see, start, type, stop or restart, change files. */
export type McpAction = 'read' | 'run' | 'input' | 'control' | 'write'

/** The level of one action and the setting of the configuration it comes from. */
export interface McpRule {
  level: McpLevel
  /** The setting declaring it, such as `projects.web.commands.dev`. */
  from: string
}

/** The level of every action on something of the configuration. */
export type McpRules = Record<McpAction, McpRule>

/** The categories of `adt.mcp` refining `adt.mcp.default` for one kind of thing. */
export type McpCategory = 'commands' | 'scripts' | 'files' | 'terminals' | 'certificates' | 'devtool' | 'integrations'

/** The global MCP settings an interface may change. */
export type McpSettingName = 'default' | McpCategory | 'ownTerminals' | 'shell' | 'clients' | 'environment'

/** Where the `mcp` setting of something is written. */
export interface McpTarget {
  /** The keys leading to the setting in the configuration files, list indexes included. */
  path: string[]
  /** The file declaring it, besides the personal override, null when only the override does. */
  declaredIn: string | null
}

/** A level and the names or command lines matching patterns that override it. */
export interface McpPatterns {
  level: McpLevel
  /** Patterns allowed without asking, `*` standing for anything. */
  allow: string[]
  /** Patterns always refused, prevailing over `allow`. */
  deny: string[]
}

/** The MCP server of the devtool and what agents may do through it. */
export interface McpSettings {
  enabled: boolean
  /** Whether the interfaces notify the requests waiting for an answer. */
  notifications: boolean
  /** Whether the agent skills of the devtool are served to the agents. */
  skills: boolean
  /** Seconds before a request without answer is refused. */
  timeout: number
  /** The rules of everything, refined by the categories below. */
  default: McpRules
  /** The rules of the commands of the configuration, refined by their sections and projects. */
  commands: McpRules
  /** The rules of the scripts, refined by their sections, projects and folders. */
  scripts: McpRules
  /** The rules of the folders of files of the projects, refined by their sections and projects. */
  files: McpRules
  /** The rules of the terminals a person opened without a command of the configuration. */
  terminals: McpRules
  /** The rules of the certificates of the load balancer, refined by each certificate. */
  certificates: McpRules
  /** The rules of the tools about the devtool itself: the holders of a port (read), reloading the configuration (control). */
  devtool: McpRules
  /** The rules of the pull requests and issues of the integrations, refined by their sections, projects and integrations. */
  integrations: McpRules
  /** The agents accepted or refused by their name, before any rule. */
  clients: McpPatterns
  /** The level of typing into and stopping the terminals an agent started itself. */
  ownTerminals: McpLevel
  /** The command lines an agent may run outside the commands of the configuration. */
  shell: McpPatterns
  /** The rules of the files and copies of the environment, refined by each item. */
  environment: McpRules
  /** The items of the environment, files, databases, buckets and Redis databases, with their rules. */
  environmentItems: McpEnvironmentItem[]
}

/** An item of the environment, with the rules of agents on it and where they are written. */
export interface McpEnvironmentItem {
  /** Its path in the environment. */
  path: string
  kind: EnvironmentItemPayload['kind']
  rules: McpRules
  target: McpTarget
}

/** The optional parts of the sidebar, each hidden unless enabled. */
export interface SidebarSettings {
  /** The link to the Environment page. */
  environment: boolean
  /** The link to the Configs page. */
  configs: boolean
  /** The sign-in state of the CDN. */
  login: boolean
  /** How the sections are ordered. */
  sort: SortMode
  /** The sections in the order chosen by hand, by slug. */
  order: string[]
  /** The sections in the order shown, by slug. */
  sections: string[]
}

/** How a list of the sidebar is ordered: as the configuration declares it, by name, or by hand. */
export type SortMode = 'config' | 'name' | 'manual'

/** How a list of the sidebar is ordered, changed from an interface and written to the personal override or the file declaring it. */
export interface SidebarOrderChange {
  /** The project whose rows and directories are ordered, null for the projects themselves. */
  section: string | null
  sort: SortMode
  /** The keys in the order chosen by hand, null to remove the order. */
  order: string[] | null
  file: 'local' | 'declared'
}

/** Names the local DNS answers itself. */
export interface DnsRecord {
  /** Exact host names, or `*.<domain>` for its subdomains. */
  names: string[]
  /** An IPv4 address, or `auto` for the current network address of this machine. */
  address: string
}

/** A DNS server the local DNS relays queries to. */
export interface DnsServerAddress {
  host: string
  port: number
}

/** The local DNS: its own names, every other name being resolved by its upstream server or the system. */
export interface DnsDefinition {
  port: number
  /** Who may query it. */
  access: HostAccess
  records: DnsRecord[]
  /** The server resolving the other names, null to resolve them through the system. */
  upstream: DnsServerAddress | null
}

/** Hosts whose TLS connections the load balancer forwards untouched, chosen by their server name. */
export interface PassthroughRule {
  /** Exact host names, or `*.<domain>` for its subdomains. */
  hosts: string[]
  host: string
  port: number
  access: HostAccess
}

export interface LoadBalancerCertificate {
  crt: string
  key: string
  /** Days before the expiry from which the interface warns, unless the certificate renews on its own. */
  warn: number
  /** How the certificate is renewed, null when it is not. */
  acme: CertificateAcme | null
  /** What agents may do with the certificate: see it, renew it. */
  mcp: McpRules
  mcpTarget: McpTarget
}

/** When a certificate is renewed: from its button, on its own before it expires, or both. */
export type CertificateTrigger = 'button' | 'auto' | 'both'

/** How a certificate is renewed: by the embedded lego, or by a command writing its files. */
export interface CertificateAcme {
  trigger: CertificateTrigger
  /** Days before the expiry from which an automatic renewal runs. */
  before: number
  /** Environment of the renewal, value blocks read when it starts. */
  env: Record<string, string>
  /** Options of `lego run` by name without their dashes, null when a command renews the certificate. */
  lego: Record<string, string | number | boolean | (string | number)[]> | null
  /** The command writing the certificate and its key, `%{ADT:CRT}` and `%{ADT:KEY}` standing for their paths; null with lego. */
  command: string[] | null
}

/** A certificate of the load balancer as the interface shows it. */
export interface CertificatePayload {
  /** Its name in the configuration. */
  name: string
  /** End of its validity, ISO date, null when it cannot be read. */
  expiresAt: string | null
  /** Common name of its issuer, null when it cannot be read. */
  issuer: string | null
  /** Why it cannot be read, or why its last renewal failed. */
  error: string | null
  /** When it is renewed, null when it is not. */
  trigger: CertificateTrigger | null
  /** Days before the expiry from which the interface warns: its `warn`, or its `before` when it renews on its own. */
  warnDays: number
  /** What its renewal is doing, null when none runs. */
  renewal: 'installing' | 'running' | null
  /** Paths of the environment holding the certificate and its key, offered for a push once renewed. */
  push: string[]
}

/** What a forge lists for a repository: its pull requests, or its issues. */
export type ForgeKind = 'pullRequests' | 'issues'

/** What an integration shows: a web page, or what a forge lists for a repository. */
export type IntegrationType = 'web' | ForgeKind

/** What an agent does with an item of a forge: review a pull request, analyze or fix an issue. */
export type AgentAction = 'review' | 'analyze' | 'fix'

/** An external tool reachable from the interface, shown in the devtool or opened in a new tab. */
export interface IntegrationDefinition {
  slug: string
  name: string
  type: IntegrationType
  /** Iconify name of its icon. */
  icon: string
  /** The page, or the web address of the repository. */
  url: string
  /** Whether the interface shows it in a frame, the load balancer then allowing the devtool to frame its host. */
  embed: boolean
  /** The forge hosting the repository, its name in the configuration and the one shown, null for a web page. */
  provider: { name: string, label: string } | null
  /** What agents may do with each item, in order. */
  agentActions: AgentAction[]
  /** The prompt of each action of agents, from the integration, the devtool settings or the devtool itself. */
  agentPrompts: Partial<Record<AgentAction, string>>
  /** Whether the sidebar counts the items waiting for the person: reviews requested, issues assigned. */
  badge: boolean
  /** Minutes between two reads of the items, 0 to read them on demand only. */
  refresh: number
  /** What agents may do with its items, null for a web page, which shows nothing to agents. */
  mcp: McpRules | null
  mcpTarget: McpTarget | null
}

/** An AI agent started with a prompt: a command run in a terminal, or a link opened by the interface. */
export interface AgentDefinition {
  slug: string
  name: string
  /** Iconify name of its icon. */
  icon: string
  /** Its command, `%{ADT:PROMPT}` standing for the prompt and `%{ADT:CWD}` for its folder, null for a link. */
  args: string[] | null
  /** Its link, with the same variables, null for a command. */
  url: string | null
  env: Record<string, string>
}

/** The state of the checks of the last commit of a pull request. */
export type PullRequestChecks = 'success' | 'pending' | 'failure'

/** Where the review of a pull request stands. */
export type PullRequestReview = 'approved' | 'changesRequested' | 'required'

/** A label of an item of a forge. */
export interface ForgeLabel {
  name: string
  /** Its color as `#rrggbb`, null when the forge gives none. */
  color: string | null
}

/** What every item of a forge has. */
export interface ForgeItemBase {
  number: number
  title: string
  url: string
  /** The username of its author, null when unknown. */
  author: string | null
  /** Its description, in Markdown. */
  body: string
  labels: ForgeLabel[]
  /** Its last change, in ISO format. */
  updatedAt: string
  /** Whether the person wrote it. */
  mine: boolean
}

/** An open issue of a repository. */
export interface IssuePayload extends ForgeItemBase {
  /** The usernames of the people it is assigned to. */
  assignees: string[]
  /** Its number of comments. */
  comments: number
  /** Whether it is assigned to the person. */
  assigned: boolean
}

/** An open pull request of a repository. */
export interface PullRequestPayload extends ForgeItemBase {
  /** Its source branch. */
  branch: string
  /** Its target branch. */
  base: string
  draft: boolean
  /** The checks of its last commit, null when it has none or the forge does not tell. */
  checks: PullRequestChecks | null
  /** Where its review stands, null when nothing is required. */
  review: PullRequestReview | null
  /** Whether a review of the person is requested. */
  reviewRequested: boolean
}

/** The open items of an integration listing what a forge holds. */
export type ForgeItemsPayload = {
  /** The integration, `<section>[/<project>]/<slug>`. */
  key: string
  /** The username the token belongs to, null when unknown. */
  viewer: string | null
  /** When the items were last read, in ISO format, null before the first read. */
  updatedAt: string | null
  loading: boolean
  /** Why the last read failed. */
  error: string | null
} & ({ kind: 'pullRequests', items: PullRequestPayload[] } | { kind: 'issues', items: IssuePayload[] })

/** Where a review of a pull request leaves it. */
export type ForgeReviewState = 'approved' | 'changesRequested' | 'commented' | 'dismissed'

/** What a change of an item of a forge is about, telling its icon. */
export type ForgeEventKind = 'label' | 'assign' | 'reviewRequest' | 'merge' | 'close' | 'reopen' | 'push' | 'rename' | 'reference' | 'draft' | 'other'

/** A comment of an item of a forge. */
export interface ForgeComment {
  /** The username of its author, null when unknown. */
  author: string | null
  /** Its text, in Markdown. */
  body: string
  /** When it was written, in ISO format. */
  createdAt: string
}

/** A discussion about lines of the code of a pull request, its first comment and the replies. */
export interface ForgeReviewThread {
  path: string
  /** The line commented, null when the forge no longer places it. */
  line: number | null
  /** The lines of the change around the comment, in the unified diff format, null when the forge gives none. */
  diffHunk: string | null
  resolved: boolean
  /** Whether the code changed since, the comment then being about an older version. */
  outdated: boolean
  comments: ForgeComment[]
}

/** Something that happened to an item of a forge, in its timeline. */
export type ForgeTimelineEvent = {
  /** The username of who did it, null when unknown. */
  author: string | null
  /** When it happened, in ISO format. */
  createdAt: string
} & (
  | { type: 'comment', body: string }
  | { type: 'review', state: ForgeReviewState, body: string, threads: ForgeReviewThread[] }
  | { type: 'commit', sha: string, message: string }
  | { type: 'event', kind: ForgeEventKind, text: string, label: ForgeLabel | null }
)

/** The timeline of an item of a forge, read when asked for. */
export interface ForgeTimelinePayload {
  /** The integration, `<section>[/<project>]/<slug>`. */
  key: string
  number: number
  /** What happened, the oldest first. */
  events: ForgeTimelineEvent[]
  /** Whether the events come before those already sent, rather than replacing them. */
  previous: boolean
  /** Where the events before these start, to read them, null when there is none. */
  before: string | null
  /** About how many events come before these. */
  remaining: number
  /** Why it could not be read. */
  error: string | null
}

/** A part of the timeline of an item: the last events, or every event before a place. */
export type ForgeTimelinePage = { last: number } | { before: string }

/** The events of a part of a timeline, and what comes before them. */
export interface ForgeTimelinePart {
  /** What happened, the oldest first. */
  events: ForgeTimelineEvent[]
  /** Where the events before these start, null when there is none. */
  before: string | null
  /** About how many events come before these. */
  remaining: number
}

/** A reference to something of a directory the sidebar offers in one click. */
export interface DirectoryShortcut {
  type: 'integration' | 'command' | 'files' | 'service'
  /** Slug of the integration, command, folder of files or service. */
  slug: string
  /** For a service, the index of the host opened. */
  index: number
}

/** What a directory does by default, a command being its main command. */
export interface DirectoryDefaultAction {
  shortcut: DirectoryShortcut
  /** `icon`: from its button in the row of the directory; `row`: on a click on the row itself; `row-icon`: both. */
  trigger: 'icon' | 'row' | 'row-icon'
  /** The icon of its button: an Iconify name, `own` for the icon of its integration, null for the icon of its type. */
  icon: string | null
}

export interface DirectoryLoadBalancerRule {
  slug: string
  hosts: string[]
  /** Where requests are sent, as http(s) URLs, shared in turn. */
  targets: string[]
  tls: boolean
  path: string | null
  prefix: string | null
  pathNot: string | null
  preserveHost: boolean
  access: HostAccess
}

/** A command of a directory: one the configuration declares, or an executable of a folder of scripts. */
export interface DirectoryExtra {
  slug: string
  name: string
  /** Its arguments, the inputs among them replaced by what is typed when it starts. */
  args: CommandArg[]
  detached: boolean
  /** Whether the command runs in the background, its questions answered in a dialog. */
  prompt: boolean
  /** Where its page asks for its inputs. */
  form: CommandForm
  /** Whether the server skips it or answers its questions on its own, as the configuration declares. */
  automated: boolean
  /** Whether the start button of its section starts it. */
  startWithSection: boolean
  notifications: boolean
  env: Record<string, string>
  shell: string | null
  killSignal: string | null
  /** What the heading comment of a script tells, null for a command of the configuration. */
  script: ScriptDescription | null
  /** What agents may do with the command and its terminals. */
  mcp: McpRules
  mcpTarget: McpTarget
  meta?: unknown
}

/** What the comment heading a script tells about it. */
export interface ScriptDescription {
  /** Its first paragraph. */
  summary: string | null
  /** Its usage lines. */
  usage: string | null
}

/** An argument typed when a command starts: one value among choices, a flag, or free text split like a shell does. */
export interface CommandInput {
  name: string
  kind: 'choice' | 'flag' | 'text'
  /** The values of a choice. */
  choices: CommandChoice[]
  /** How a choice is picked. */
  display: 'buttons' | 'dropdown'
  /** Whether a choice may be left out. */
  optional: boolean
  /** The value given before anything is typed, null for none. */
  default: CommandInputValue | null
}

/** A value of a choice and the text shown for it. */
export interface CommandChoice {
  label: string
  value: string
}

/** Where the page of a directory asks for the inputs of a command: in a dialog, or in its row. */
export type CommandForm = 'dialog' | 'inline'

/** An argument of a command: a fixed value, or an input typed when it starts. */
export type CommandArg = string | CommandInput

/** The value typed for an input: the value of a choice or a text, whether a flag is set. */
export type CommandInputValue = string | boolean

/** What the configuration declares about one script. */
export interface ScriptSettings {
  /** Whether the script runs in the background, null to follow its folder. */
  prompt: boolean | null
  /** Its arguments after its path, null for one free text input. */
  args: CommandArg[] | null
  /** Where its page asks for its inputs, null to follow its folder. */
  form: CommandForm | null
  /** What agents may do with the script. */
  mcp: McpRules
  mcpTarget: McpTarget
}

/** A folder whose executables a directory offers as scripts. */
export interface DirectoryScripts {
  /** Absolute path of the folder. */
  path: string
  /** Whether its scripts run in the background, their questions answered in a dialog. */
  prompt: boolean
  /** Where the page of its scripts asks for their inputs. */
  form: CommandForm
  /** Glob patterns of the file names offered, null for every executable. */
  only: string[] | null
  /** Settings of some scripts, by file name. */
  scripts: Record<string, ScriptSettings>
  /** What agents may do with its scripts. */
  mcp: McpRules
  mcpTarget: McpTarget
}

/** What a folder of files holds: any files, or one agent skill per folder. */
export type DirectoryFilesType = 'files' | 'agentSkills'

/** A folder of editable files declared by a directory. */
export interface DirectoryFiles {
  slug: string
  name: string
  type: DirectoryFilesType
  /** Absolute path of the folder. */
  path: string
  /** Extras of the directory offered next to the files. */
  commands: string[]
  /** The extra of the directory bringing the folder back when it is missing, null when there is none. */
  restore: string | null
  /** What agents may do with the files. */
  mcp: McpRules
  mcpTarget: McpTarget
  /** For agent skills, the globs of the skill folders served to the agents, null to serve none. */
  mcpSkills: string[] | null
  /** Whether the files and folders whose name starts with a dot are shown, `.git` never being. */
  showHidden: boolean
}

export interface DirectoryDefinition {
  slug: string
  name: string
  description?: string | null
  path: string
  loadBalancer: Record<string, DirectoryLoadBalancerRule>
  /** Arguments of the default command, its inputs included, null when the directory has none. */
  args: CommandArg[] | null
  extras: Record<string, DirectoryExtra>
  /** The folders whose executables are offered as scripts. */
  scripts: DirectoryScripts[]
  files: Record<string, DirectoryFiles>
  /** What the directory does by default, null when it declares nothing. */
  defaultAction: DirectoryDefaultAction | null
  /** The integrations of the directory, in the order of the configuration. */
  integrations: IntegrationDefinition[]
  /** Shown as icons in the row of the directory, in order. */
  icons: DirectoryShortcut[]
  /** Shown as rows under the row of the directory, in order. */
  lines: DirectoryShortcut[]
  notifications: boolean
  env: Record<string, string>
  shell: string | null
  killSignal: string | null
  /** Whether the folder of the directory is missing, the directory then offering only its restore. */
  missing: boolean
  restore: ProjectRestore | null
  /** What agents may do in the directory, `adt.mcp.default` refined by its section and itself. */
  mcp: McpRules
  mcpTarget: McpTarget
  /** The rule of running its restore, a command of the configuration. */
  restoreRule: McpRule
  meta?: unknown
}

/** The command bringing back the folder of a project when it is missing, such as a clone of its repository. */
export interface ProjectRestore {
  name: string
  /** Its arguments, `%{ADT:PATH}` standing for the missing folder. */
  args: string[]
}

export interface ProjectDefinition {
  slug: string
  name: string
  description?: string | null
  path: string
  directories: Record<string, DirectoryDefinition>
  notifications: boolean
  /** Whether the folder of the project is missing, the project then having no directory. */
  missing: boolean
  restore: ProjectRestore | null
  /** What agents may do in the project, `adt.mcp.default` refined by itself. */
  mcp: McpRules
  mcpTarget: McpTarget
  /** The rule of running its restore, a command of the configuration. */
  restoreRule: McpRule
  /** The integrations of the project itself, in the order of the configuration. */
  integrations: IntegrationDefinition[]
  /** Shown as icons in the header of the project, in order. */
  icons: DirectoryShortcut[]
  /** Shown as rows under the header of the project, in order. */
  lines: DirectoryShortcut[]
  /** How its rows and directories are ordered. */
  sort: SortMode
  /** Its rows and directories in the order chosen by hand: a directory by its slug, a row by its shortcut. */
  order: string[]
  /** Its rows and directories in the order shown, named like in `order`. */
  content: string[]
  meta?: unknown
}

export interface RuntimeConfig {
  adt: AdtDefinition
  loadBalancers: Record<string, LoadBalancerCertificate>
  passthrough: PassthroughRule[]
  /** The local DNS, null when no record is declared. */
  dns: DnsDefinition | null
  /** The integrations, in the order of the configuration. */
  integrations: IntegrationDefinition[]
  projects: Record<string, ProjectDefinition>
  warnings: string[]
}

export interface ClientConfigPayload {
  version: string
  /** The identifier of the devtool, such as the name of its MCP server. */
  name: string
  /** The name shown to people. */
  displayName: string
  warnings: string[]
  loadBalancers: string[]
  integrations: IntegrationDefinition[]
  projects: Record<string, ProjectDefinition>
  sidebar: SidebarSettings
  /** The AI agents the interface starts. */
  agents: AgentDefinition[]
  /** The MCP server and its rules, those of the certificates by name. */
  mcp: McpSettings & {
    port: number
    certificatesByName: Record<string, { rules: McpRules, target: McpTarget }>
    /** Where the settings of `adt.mcp` and `environment.mcp` are written. */
    targets: Record<McpSettingName, McpTarget>
    /** The personal override changes are written to by default, null when the server loads none. */
    localFile: string | null
  }
}

export interface StreamOutputLine {
  date: number
  type: 'stdout' | 'stderr' | 'stdin' | 'info'
  content: string
}

export interface StreamUpdatePayload {
  slug: string
  projectSlug: string | null
  directorySlug: string | null
  primary: boolean
  name: string
  /** Identifies the stream for the interface that started it. */
  tag: string | null
  /** The agent that started the stream, null when a person did. */
  origin: string | null
  /** The command of the directory the stream runs, null for any other command. */
  command: string | null
  args: string[]
  env: Record<string, string>
  shell: string | null
  killSignal: string | null
  cwd: string
  notifications: boolean
  creationDate: number
  runningDate: number | null
  runningArgs: string[] | null
  stoppedDate: number | null
  exitCode: number | null
  /** The port the command could not use because other processes hold it, null when none. */
  portConflict: PortConflict | null
}

/** A process listening on a port. */
export interface PortOwner {
  pid: number
  command: string
}

/** A port a command could not use, and the processes holding it. */
export interface PortConflict {
  port: number
  owners: PortOwner[]
}

/** What to do about a port conflict: stop its holders, also running the command again, or leave it. */
export type PortConflictAction = 'kill' | 'killAndRestart' | 'dismiss'

/** Sign-in state of the developer with the identity provider of the configuration. */
export interface AuthSessionPayload {
  /** Whether the configuration declares an identity provider. */
  configured: boolean
  /** Name shown for the identity provider, null when the configuration gives none. */
  providerName: string | null
  signedIn: boolean
  user: {
    name: string | null
    username: string | null
    email: string | null
    groups: string[]
  } | null
  /** Sign-in address to open while a sign-in started from the interface waits for the identity provider. */
  pendingLoginUrl: string | null
  /** Why the last sign-in started from the interface failed. */
  error: string | null
}

/** Size and last change of a copy of an environment item, the date in ISO format. */
export interface EnvironmentCopyPayload {
  size: number
  updatedAt: string
}

/** An item of the development environment with its local copy and its copy on its backend. */
export interface EnvironmentItemPayload {
  path: string
  kind: 'file' | 'database' | 'bucket' | 'redis'
  /** The name of the backend storing the item, null when the environment declares none. */
  backend: string | null
  /** Whether the file is encrypted before it reaches its backend. */
  encrypted: boolean
  engine: string | null
  container: string | null
  /** The database of the container a database item names, null for the default one of its image or another kind of item. */
  database: string | null
  bucket: string | null
  /** Archive format of a database or a bucket, null for another kind of item. */
  format: 'devtool' | 'native' | null
  /** Whether the groups of the developer let them pull and push the item. */
  allowed: { pull: boolean, push: boolean }
  /** The Redis server and database number, without credentials. */
  redis: string | null
  /** Whether the item is a configuration file whose keys can be pulled or pushed one by one. */
  keyed: boolean
  local: EnvironmentCopyPayload | null
  /** The copy of the backend, null when there is none, "unknown" when the backend could not list its files. */
  remote: EnvironmentCopyPayload | null | 'unknown'
  /** Dates of both copies, in ISO format, when a pull or a push last made them equal. */
  synced: { localUpdatedAt: string, remoteUpdatedAt: string } | null
  /** What the local copy of a PEM file holds, null for any other item. */
  pem: EnvironmentPemPayload | null
}

/** A certificate, with the end of its validity in ISO format, or a private key. */
export type EnvironmentPemPayload = { kind: 'certificate', expiresAt: string } | { kind: 'privateKey' }

/** A value of a key of a configuration file in one copy of it. */
export interface EnvironmentKeyValuePayload {
  present: boolean
  value: unknown
}

/** A key whose value differs between the local and CDN copies of a configuration file. */
export interface EnvironmentKeyPayload {
  path: string[]
  local: EnvironmentKeyValuePayload
  remote: EnvironmentKeyValuePayload
}

/** Keys differing between the local and CDN copies of a configuration file. */
export interface EnvironmentKeysPayload {
  path: string
  entries: EnvironmentKeyPayload[]
  error: string | null
}

/** The copy whose value a key of a configuration file takes. */
export interface EnvironmentKeyChoicePayload {
  path: string[]
  side: 'local' | 'remote'
}

/** Progress of one item of a pull or a push. */
export interface EnvironmentStepPayload {
  target: string
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed'
  detail: string | null
}

/** A pull or a push of environment items, running or finished. */
export interface EnvironmentRunPayload {
  direction: 'pull' | 'push'
  steps: EnvironmentStepPayload[]
  finished: boolean
}

/** A backend of the development environment. */
export interface EnvironmentBackendPayload {
  name: string
  /** Its kind: cdn, s3, sftp, git or scripts. */
  type: string
  /** Whether items naming no backend use it. */
  default: boolean
  /** Whether it encrypts every file it stores. */
  encrypted: boolean
}

/** State of the development environment. */
export interface EnvironmentPayload {
  /** Whether the configuration declares an environment with at least one backend. */
  configured: boolean
  /** The backends of the environment, in their declaration order. */
  backends: EnvironmentBackendPayload[]
  items: EnvironmentItemPayload[]
  /** Why the copies of a backend are unknown, by backend, or why the environment could not be read. */
  error: string | null
  run: EnvironmentRunPayload | null
}

/** A secret the server asks the developer to type, such as the password of encrypted files. */
export interface SecretRequestPayload {
  id: string
  /** What the secret unlocks. */
  label: string
}

/** Tables of the local database of an environment item, or key groups of its local Redis database. */
export interface EnvironmentTablesPayload {
  path: string
  tables: string[]
  error: string | null
}

/** A file or folder of a file space, its path relative to the root. */
export interface FileEntryPayload {
  path: string
  kind: 'file' | 'directory'
}

/** The files of a file space. */
export interface FileTreePayload {
  space: string
  /** Absolute path of the root of the space. */
  root: string
  /** Whether the root exists. */
  exists: boolean
  /** Whether files and folders can be created, renamed and removed. */
  editable: boolean
  entries: FileEntryPayload[]
  /** The skills of a folder of agent skills, one per folder at its root, null for any other folder. */
  agentSkills: AgentSkillSummary[] | null
  /** Why the files could not be listed or changed. */
  error: string | null
}

/** An agent skill of a folder of agent skills. */
export interface AgentSkillSummary {
  /** Its folder, at the root of the space. */
  folder: string
  /** Its name, null when its header gives none. */
  name: string | null
  /** Its description, null when its header gives none. */
  description: string | null
  /** What does not follow the format of agent skills. */
  problems: string[]
}

/** A file of a file space, as it stands on disk. */
export interface FilePayload {
  space: string
  path: string
  /** Text content, null when the file does not exist or is binary. */
  content: string | null
  /** Whether the file holds binary data, never sent. */
  binary: boolean
  /** Last change of the file, in ISO format, null when it does not exist. */
  updatedAt: string | null
  /** Whether the file was just replaced by a write. */
  saved: boolean
  /** Whether a write was refused because the file changed since it was read. */
  conflict: boolean
  /** Why the file could not be read or written. */
  error: string | null
}

export interface WsPayloadMap {
  config: ClientConfigPayload
  fileTree: FileTreePayload
  file: FilePayload
  authSession: AuthSessionPayload
  environment: EnvironmentPayload
  secretRequest: SecretRequestPayload
  secretDone: { id: string }
  certificates: CertificatePayload[]
  forgeItems: ForgeItemsPayload[]
  forgeTimeline: ForgeTimelinePayload
  environmentTables: EnvironmentTablesPayload
  environmentKeys: EnvironmentKeysPayload
  streamUpdate: StreamUpdatePayload
  streamOutput: {
    slug: string
    output: StreamOutputLine[]
    initial: boolean
  }
  streamRedirect: {
    streamSlug: string
  }
  streamRemove: {
    slug: string
  }
  mcpState: McpStatePayload
  mcpHistory: {
    entries: McpHistoryEntry[]
    /** Whether the entries replace the whole history rather than follow it. */
    initial: boolean
  }
  mcpMessage: McpMessagePayload
}

/** How a call of an agent was decided. */
export type McpDecision = 'auto' | 'once' | 'session' | 'always' | 'denied' | 'config' | 'timeout' | 'noUi' | 'cancelled'

/** Whether an agent is accepted: waiting for an answer, for its session, always, by the configuration, or refused. */
export type McpClientStatus = 'pending' | 'session' | 'always' | 'config' | 'denied'

/** What an answer to a request of an agent grants. */
export type McpAnswer = 'deny' | 'once' | 'session' | 'always'

/** A labelled value describing a call of an agent. */
export interface McpDetail {
  label: string
  value: string
  /** Whether the value is shown in a request only, never kept in the history. */
  secret?: boolean
}

/** A session of an agent connected to the MCP server. */
export interface McpSessionPayload {
  id: string
  client: string
  version: string | null
  connectedAt: number
  calls: number
  status: McpClientStatus
}

/** An agent accepted or refused by name, by the configuration or always. */
export interface McpClientPayload {
  name: string
  source: 'allow' | 'deny' | 'always'
  /** When it was accepted always, null for the configuration. */
  date: number | null
}

/** A request of an agent waiting for an answer of a person. */
export interface McpRequestPayload {
  id: string
  /** `client` asks to accept the agent itself, `permission` to let it make a call. */
  kind: 'client' | 'permission'
  session: string
  client: string
  tool: string
  action: McpAction | null
  title: string
  details: McpDetail[]
  /** Named keys the call presses in a terminal. */
  keys: string[]
  /** The command of the configuration it runs, `<section>/<project>/<slug>`, whose inputs may be changed. */
  command: string | null
  /** The values of the inputs of that command, in order. */
  inputs: CommandInputValue[] | null
  /** The content of a file before and after the call. */
  diff: { path: string, before: string, after: string } | null
  notify: boolean
  createdAt: number
  expiresAt: number
  /** Names what an answer for the session or always grants, null when only this call can be granted. */
  grantKey: string | null
  /** Whether the call may be granted for the session, and always. */
  grantable: { session: boolean, always: boolean }
}

/** A call an agent may make without asking again, for its session or always. */
export interface McpGrantPayload {
  key: string
  label: string
  scope: 'session' | 'always'
  /** The session granted, null for always. */
  session: string | null
  client: string | null
  date: number
}

/** A call made by an agent, as the history keeps it. */
export interface McpHistoryEntry {
  id: string
  date: number
  session: string
  client: string
  tool: string
  /** What the call acted on, null when nothing in particular. */
  target: string | null
  action: McpAction | null
  details: McpDetail[]
  grantKey: string | null
  grantLabel: string | null
  decision: McpDecision
  /** The setting refusing the call, for a refusal by the configuration. */
  reason: string | null
  ok: boolean
  /** The error, or a short summary of the result. */
  message: string | null
  /** The arguments of the call, the private ones left out. */
  input: McpDetail[]
  duration: number
  /** The part of the duration spent waiting for a person to answer. */
  waited: number
  /** How the agent was accepted by a person during the call, null when it was accepted before. */
  acceptance: 'session' | 'always' | null
  /** The terminal the call acted on or started. */
  terminal: string | null
}

/** The MCP server as the interfaces show it. */
export interface McpStatePayload {
  enabled: boolean
  port: number
  sessions: McpSessionPayload[]
  clients: McpClientPayload[]
  pending: McpRequestPayload[]
  grants: McpGrantPayload[]
  /** The display names the agents connected since the start gave, by name. */
  titles: Record<string, string>
}

/** A message of an agent to the person using the devtool. */
export interface McpMessagePayload {
  id: string
  client: string
  message: string
  level: 'info' | 'warning' | 'error'
  date: number
}
