/** Who reaches a host through the load balancer: clients of this machine only, or any client. */
export type HostAccess = "local" | "network";

export interface AdtDefinition {
  /** The identifier of the devtool, such as the name of its MCP server. */
  name: string;
  /** The name shown to people, such as the name of its app and of its interface. */
  displayName: string;
  /** The image of its icon, null for the default one. */
  icon: string | null;
  host: string | null;
  /** The interface, from the startup options only: a folder of static files or the URL of a server. */
  uiPath?: string;
  /** Folder of the files the devtool rebuilds or keeps between runs, given to the commands as `APPSYS_DEVTOOL_CACHE_DIR`. */
  cacheDir: string;
  shell: string | null;
  ports: {
    server: number;
    loadBalancer: number;
  };
  secure: boolean;
  notifications: boolean;
  hosts: string[];
  /** Who reaches the interface of the devtool. */
  access: HostAccess;
  sidebar: SidebarSettings;
  /** What agents may do through the MCP server of the devtool. */
  mcp: McpSettings;
}

/** How an agent may do something: freely, after asking, on the keys of a file only, or never. */
export type McpLevel = "allow" | "ask" | "keys" | "deny";

/** What an agent does: see, start, type, stop or restart, change files. */
export type McpAction = "read" | "run" | "input" | "control" | "write";

/** The level of one action and the setting of the configuration it comes from. */
export interface McpRule {
  level: McpLevel;
  /** The setting declaring it, such as `projects.web.commands.dev`. */
  from: string;
}

/** The level of every action on something of the configuration. */
export type McpRules = Record<McpAction, McpRule>;

/** The categories of `adt.mcp` refining `adt.mcp.default` for one kind of thing. */
export type McpCategory = "commands" | "scripts" | "files" | "terminals" | "certificates" | "devtool";

/** The global MCP settings an interface may change. */
export type McpSettingName = "default" | McpCategory | "ownTerminals" | "shell" | "clients" | "environment";

/** Where the `mcp` setting of something is written. */
export interface McpTarget {
  /** The keys leading to the setting in the configuration files, list indexes included. */
  path: string[];
  /** The file declaring it, besides the personal override, null when only the override does. */
  declaredIn: string | null;
}

/** A level and the names or command lines matching patterns that override it. */
export interface McpPatterns {
  level: McpLevel;
  /** Patterns allowed without asking, `*` standing for anything. */
  allow: string[];
  /** Patterns always refused, prevailing over `allow`. */
  deny: string[];
}

/** The MCP server of the devtool and what agents may do through it. */
export interface McpSettings {
  enabled: boolean;
  /** Whether the interfaces notify the requests waiting for an answer. */
  notifications: boolean;
  /** Seconds before a request without answer is refused. */
  timeout: number;
  /** The rules of everything, refined by the categories below. */
  default: McpRules;
  /** The rules of the commands of the configuration, refined by their sections and projects. */
  commands: McpRules;
  /** The rules of the scripts, refined by their sections, projects and folders. */
  scripts: McpRules;
  /** The rules of the folders of files of the projects, refined by their sections and projects. */
  files: McpRules;
  /** The rules of the terminals a person opened without a command of the configuration. */
  terminals: McpRules;
  /** The rules of the certificates of the load balancer, refined by each certificate. */
  certificates: McpRules;
  /** The rules of the tools about the devtool itself: the holders of a port (read), reloading the configuration (control). */
  devtool: McpRules;
  /** The agents accepted or refused by their name, before any rule. */
  clients: McpPatterns;
  /** The level of typing into and stopping the terminals an agent started itself. */
  ownTerminals: McpLevel;
  /** The command lines an agent may run outside the commands of the configuration. */
  shell: McpPatterns;
  /** The rules of the files and copies of the environment. */
  environment: McpRules;
}

/** The optional parts of the sidebar, each hidden unless enabled. */
export interface SidebarSettings {
  /** The link to the Environment page. */
  environment: boolean;
  /** The link to the Configs page. */
  configs: boolean;
  /** The sign-in state of the CDN. */
  login: boolean;
}

/** Names the local DNS answers itself. */
export interface DnsRecord {
  /** Exact host names, or `*.<domain>` for its subdomains. */
  names: string[];
  /** An IPv4 address, or `auto` for the current network address of this machine. */
  address: string;
}

/** The local DNS: its own names, every other name being resolved by the system. */
export interface DnsDefinition {
  port: number;
  /** Who may query it. */
  access: HostAccess;
  records: DnsRecord[];
}

/** Hosts whose TLS connections the load balancer forwards untouched, chosen by their server name. */
export interface PassthroughRule {
  /** Exact host names, or `*.<domain>` for its subdomains. */
  hosts: string[];
  host: string;
  port: number;
  access: HostAccess;
}

export interface LoadBalancerCertificate {
  crt: string;
  key: string;
  /** Days before the expiry from which the interface warns, unless the certificate renews on its own. */
  warn: number;
  /** How the certificate is renewed, null when it is not. */
  acme: CertificateAcme | null;
  /** What agents may do with the certificate: see it, renew it. */
  mcp: McpRules;
  mcpTarget: McpTarget;
}

/** When a certificate is renewed: from its button, on its own before it expires, or both. */
export type CertificateTrigger = "button" | "auto" | "both";

/** How a certificate is renewed: by the embedded lego, or by a command writing its files. */
export interface CertificateAcme {
  trigger: CertificateTrigger;
  /** Days before the expiry from which an automatic renewal runs. */
  before: number;
  /** Environment of the renewal, value blocks read when it starts. */
  env: Record<string, string>;
  /** Options of `lego run` by name without their dashes, null when a command renews the certificate. */
  lego: Record<string, string | number | boolean | (string | number)[]> | null;
  /** The command writing the certificate and its key, `%{ADT:CRT}` and `%{ADT:KEY}` standing for their paths; null with lego. */
  command: string[] | null;
}

/** A certificate of the load balancer as the interface shows it. */
export interface CertificatePayload {
  /** Its name in the configuration. */
  name: string;
  /** End of its validity, ISO date, null when it cannot be read. */
  expiresAt: string | null;
  /** Common name of its issuer, null when it cannot be read. */
  issuer: string | null;
  /** Why it cannot be read, or why its last renewal failed. */
  error: string | null;
  /** When it is renewed, null when it is not. */
  trigger: CertificateTrigger | null;
  /** Days before the expiry from which the interface warns: its `warn`, or its `before` when it renews on its own. */
  warnDays: number;
  /** What its renewal is doing, null when none runs. */
  renewal: "installing" | "running" | null;
  /** Paths of the environment holding the certificate and its key, offered for a push once renewed. */
  push: string[];
}

/** An external tool reachable from the interface, shown in the devtool or opened in a new tab. */
export interface IntegrationDefinition {
  slug: string;
  name: string;
  /** Iconify name of its icon. */
  icon: string;
  url: string;
  /** Whether the interface shows it in a frame, the load balancer then allowing the devtool to frame its host. */
  embed: boolean;
}

/** A reference to something of a directory the sidebar offers in one click. */
export interface DirectoryShortcut {
  type: "integration" | "command" | "files" | "service";
  /** Slug of the integration, command, folder of files or service. */
  slug: string;
  /** For a service, the index of the host opened. */
  index: number;
}

/** What a directory does by default, a command being its main command. */
export interface DirectoryDefaultAction {
  shortcut: DirectoryShortcut;
  /** `icon`: from its button in the row of the directory; `row`: on a click on the row itself; `row-icon`: both. */
  trigger: "icon" | "row" | "row-icon";
  /** The icon of its button: an Iconify name, `own` for the icon of its integration, null for the icon of its type. */
  icon: string | null;
}

export interface DirectoryLoadBalancerRule {
  slug: string;
  hosts: string[];
  /** Where requests are sent, as http(s) URLs, shared in turn. */
  targets: string[];
  tls: boolean;
  path: string | null;
  prefix: string | null;
  pathNot: string | null;
  preserveHost: boolean;
  access: HostAccess;
}

/** A command of a directory: one the configuration declares, or an executable of a folder of scripts. */
export interface DirectoryExtra {
  slug: string;
  name: string;
  /** Its arguments, the inputs among them replaced by what is typed when it starts. */
  args: CommandArg[];
  detached: boolean;
  /** Whether the command runs in the background, its questions answered in a dialog. */
  prompt: boolean;
  /** Where its page asks for its inputs. */
  form: CommandForm;
  /** Whether the server skips it or answers its questions on its own, as the configuration declares. */
  automated: boolean;
  /** Whether the start button of its section starts it. */
  startWithSection: boolean;
  notifications: boolean;
  env: Record<string, string>;
  shell: string | null;
  killSignal: string | null;
  /** What the heading comment of a script tells, null for a command of the configuration. */
  script: ScriptDescription | null;
  /** What agents may do with the command and its terminals. */
  mcp: McpRules;
  mcpTarget: McpTarget;
  meta?: unknown;
}

/** What the comment heading a script tells about it. */
export interface ScriptDescription {
  /** Its first paragraph. */
  summary: string | null;
  /** Its usage lines. */
  usage: string | null;
}

/** An argument typed when a command starts: one value among choices, a flag, or free text split like a shell does. */
export interface CommandInput {
  name: string;
  kind: "choice" | "flag" | "text";
  /** The values of a choice. */
  choices: CommandChoice[];
  /** How a choice is picked. */
  display: "buttons" | "dropdown";
  /** Whether a choice may be left out. */
  optional: boolean;
  /** The value given before anything is typed, null for none. */
  default: CommandInputValue | null;
}

/** A value of a choice and the text shown for it. */
export interface CommandChoice {
  label: string;
  value: string;
}

/** Where the page of a directory asks for the inputs of a command: in a dialog, or in its row. */
export type CommandForm = "dialog" | "inline";

/** An argument of a command: a fixed value, or an input typed when it starts. */
export type CommandArg = string | CommandInput;

/** The value typed for an input: the value of a choice or a text, whether a flag is set. */
export type CommandInputValue = string | boolean;

/** What the configuration declares about one script. */
export interface ScriptSettings {
  /** Whether the script runs in the background, null to follow its folder. */
  prompt: boolean | null;
  /** Its arguments after its path, null for one free text input. */
  args: CommandArg[] | null;
  /** Where its page asks for its inputs, null to follow its folder. */
  form: CommandForm | null;
  /** What agents may do with the script. */
  mcp: McpRules;
  mcpTarget: McpTarget;
}

/** A folder whose executables a directory offers as scripts. */
export interface DirectoryScripts {
  /** Absolute path of the folder. */
  path: string;
  /** Whether its scripts run in the background, their questions answered in a dialog. */
  prompt: boolean;
  /** Where the page of its scripts asks for their inputs. */
  form: CommandForm;
  /** Glob patterns of the file names offered, null for every executable. */
  only: string[] | null;
  /** Settings of some scripts, by file name. */
  scripts: Record<string, ScriptSettings>;
  /** What agents may do with its scripts. */
  mcp: McpRules;
  mcpTarget: McpTarget;
}

/** A folder of editable files declared by a directory. */
export interface DirectoryFiles {
  slug: string;
  name: string;
  /** Absolute path of the folder. */
  path: string;
  /** Extras of the directory offered next to the files. */
  commands: string[];
  /** The extra of the directory bringing the folder back when it is missing, null when there is none. */
  restore: string | null;
  /** What agents may do with the files. */
  mcp: McpRules;
  mcpTarget: McpTarget;
}

export interface DirectoryDefinition {
  slug: string;
  name: string;
  description?: string | null;
  path: string;
  loadBalancer: Record<string, DirectoryLoadBalancerRule>;
  /** Arguments of the default command, its inputs included, null when the directory has none. */
  args: CommandArg[] | null;
  extras: Record<string, DirectoryExtra>;
  /** The folders whose executables are offered as scripts. */
  scripts: DirectoryScripts[];
  files: Record<string, DirectoryFiles>;
  /** What the directory does by default, null when it declares nothing. */
  defaultAction: DirectoryDefaultAction | null;
  /** The integrations of the directory, in the order of the configuration. */
  integrations: IntegrationDefinition[];
  /** Shown as icons in the row of the directory, in order. */
  icons: DirectoryShortcut[];
  /** Shown as rows under the row of the directory, in order. */
  lines: DirectoryShortcut[];
  notifications: boolean;
  env: Record<string, string>;
  shell: string | null;
  killSignal: string | null;
  /** Whether the folder of the directory is missing, the directory then offering only its restore. */
  missing: boolean;
  restore: ProjectRestore | null;
  /** What agents may do in the directory, `adt.mcp.default` refined by its section and itself. */
  mcp: McpRules;
  mcpTarget: McpTarget;
  /** The rule of running its restore, a command of the configuration. */
  restoreRule: McpRule;
  meta?: unknown;
}

/** The command bringing back the folder of a project when it is missing, such as a clone of its repository. */
export interface ProjectRestore {
  name: string;
  /** Its arguments, `%{ADT:PATH}` standing for the missing folder. */
  args: string[];
}

export interface ProjectDefinition {
  slug: string;
  name: string;
  description?: string | null;
  path: string;
  directories: Record<string, DirectoryDefinition>;
  notifications: boolean;
  /** Whether the folder of the project is missing, the project then having no directory. */
  missing: boolean;
  restore: ProjectRestore | null;
  /** What agents may do in the project, `adt.mcp.default` refined by itself. */
  mcp: McpRules;
  mcpTarget: McpTarget;
  /** The rule of running its restore, a command of the configuration. */
  restoreRule: McpRule;
  meta?: unknown;
}

export interface RuntimeConfig {
  adt: AdtDefinition;
  loadBalancers: Record<string, LoadBalancerCertificate>;
  passthrough: PassthroughRule[];
  /** The local DNS, null when no record is declared. */
  dns: DnsDefinition | null;
  /** The integrations, in the order of the configuration. */
  integrations: IntegrationDefinition[];
  projects: Record<string, ProjectDefinition>;
  warnings: string[];
}

export interface ClientConfigPayload {
  version: string;
  /** The identifier of the devtool, such as the name of its MCP server. */
  name: string;
  /** The name shown to people. */
  displayName: string;
  warnings: string[];
  loadBalancers: string[];
  integrations: IntegrationDefinition[];
  projects: Record<string, ProjectDefinition>;
  sidebar: SidebarSettings;
  /** The MCP server and its rules, those of the certificates by name. */
  mcp: McpSettings & {
    port: number;
    certificatesByName: Record<string, { rules: McpRules; target: McpTarget }>;
    /** Where the settings of `adt.mcp` and `environment.mcp` are written. */
    targets: Record<McpSettingName, McpTarget>;
    /** The personal override changes are written to by default, null when the server loads none. */
    localFile: string | null;
  };
}

export interface StreamOutputLine {
  date: number;
  type: "stdout" | "stderr" | "stdin" | "info";
  content: string;
}

export interface StreamUpdatePayload {
  slug: string;
  projectSlug: string | null;
  directorySlug: string | null;
  primary: boolean;
  name: string;
  /** Identifies the stream for the interface that started it. */
  tag: string | null;
  /** The agent that started the stream, null when a person did. */
  origin: string | null;
  /** The command of the directory the stream runs, null for any other command. */
  command: string | null;
  args: string[];
  env: Record<string, string>;
  shell: string | null;
  killSignal: string | null;
  cwd: string;
  notifications: boolean;
  creationDate: number;
  runningDate: number | null;
  runningArgs: string[] | null;
  stoppedDate: number | null;
  exitCode: number | null;
  /** The port the command could not use because other processes hold it, null when none. */
  portConflict: PortConflict | null;
}

/** A process listening on a port. */
export interface PortOwner {
  pid: number;
  command: string;
}

/** A port a command could not use, and the processes holding it. */
export interface PortConflict {
  port: number;
  owners: PortOwner[];
}

/** What to do about a port conflict: stop its holders, also running the command again, or leave it. */
export type PortConflictAction = "kill" | "killAndRestart" | "dismiss";

/** Sign-in state of the developer on the CDN. */
export interface CdnSessionPayload {
  /** Whether the configuration declares a CDN. */
  configured: boolean;
  /** Name shown for the OpenID Connect issuer signing in, null when the configuration gives none. */
  issuerName: string | null;
  signedIn: boolean;
  user: {
    name: string | null;
    username: string | null;
    groups: string[];
  } | null;
  /** Sign-in address to open while a sign-in started from the interface waits for the issuer. */
  pendingLoginUrl: string | null;
  /** Why the last sign-in started from the interface failed. */
  error: string | null;
}

/** Size and last change of a copy of an environment item, the date in ISO format. */
export interface EnvironmentCopyPayload {
  size: number;
  updatedAt: string;
}

/** An item of the development environment with its local copy and its copy on the CDN. */
export interface EnvironmentItemPayload {
  path: string;
  kind: "file" | "database" | "bucket" | "redis";
  engine: string | null;
  container: string | null;
  bucket: string | null;
  /** The Redis server and database number, without credentials. */
  redis: string | null;
  /** Whether the item is a configuration file whose keys can be pulled or pushed one by one. */
  keyed: boolean;
  local: EnvironmentCopyPayload | null;
  /** The CDN copy, null when there is none, "unknown" when the CDN copies could not be listed. */
  remote: EnvironmentCopyPayload | null | "unknown";
  /** Dates of both copies, in ISO format, when a pull or a push last made them equal. */
  synced: { localUpdatedAt: string; remoteUpdatedAt: string } | null;
  /** What the local copy of a PEM file holds, null for any other item. */
  pem: EnvironmentPemPayload | null;
}

/** A certificate, with the end of its validity in ISO format, or a private key. */
export type EnvironmentPemPayload = { kind: "certificate"; expiresAt: string } | { kind: "privateKey" };

/** A value of a key of a configuration file in one copy of it. */
export interface EnvironmentKeyValuePayload {
  present: boolean;
  value: unknown;
}

/** A key whose value differs between the local and CDN copies of a configuration file. */
export interface EnvironmentKeyPayload {
  path: string[];
  local: EnvironmentKeyValuePayload;
  remote: EnvironmentKeyValuePayload;
}

/** Keys differing between the local and CDN copies of a configuration file. */
export interface EnvironmentKeysPayload {
  path: string;
  entries: EnvironmentKeyPayload[];
  error: string | null;
}

/** The copy whose value a key of a configuration file takes. */
export interface EnvironmentKeyChoicePayload {
  path: string[];
  side: "local" | "remote";
}

/** Progress of one item of a pull or a push. */
export interface EnvironmentStepPayload {
  target: string;
  status: "pending" | "running" | "done" | "skipped" | "failed";
  detail: string | null;
}

/** A pull or a push of environment items, running or finished. */
export interface EnvironmentRunPayload {
  direction: "pull" | "push";
  steps: EnvironmentStepPayload[];
  finished: boolean;
}

/** State of the development environment. */
export interface EnvironmentPayload {
  /** Whether the configuration declares an environment and a CDN. */
  configured: boolean;
  items: EnvironmentItemPayload[];
  /** Why the CDN copies are unknown, or why the environment could not be read. */
  error: string | null;
  run: EnvironmentRunPayload | null;
}

/** Tables of the local database of an environment item, or key groups of its local Redis database. */
export interface EnvironmentTablesPayload {
  path: string;
  tables: string[];
  error: string | null;
}

/** A file or folder of a file space, its path relative to the root. */
export interface FileEntryPayload {
  path: string;
  kind: "file" | "directory";
}

/** The files of a file space. */
export interface FileTreePayload {
  space: string;
  /** Absolute path of the root of the space. */
  root: string;
  /** Whether the root exists. */
  exists: boolean;
  /** Whether files and folders can be created, renamed and removed. */
  editable: boolean;
  entries: FileEntryPayload[];
  /** Why the files could not be listed or changed. */
  error: string | null;
}

/** A file of a file space, as it stands on disk. */
export interface FilePayload {
  space: string;
  path: string;
  /** Text content, null when the file does not exist or is binary. */
  content: string | null;
  /** Whether the file holds binary data, never sent. */
  binary: boolean;
  /** Last change of the file, in ISO format, null when it does not exist. */
  updatedAt: string | null;
  /** Whether the file was just replaced by a write. */
  saved: boolean;
  /** Whether a write was refused because the file changed since it was read. */
  conflict: boolean;
  /** Why the file could not be read or written. */
  error: string | null;
}

export interface WsPayloadMap {
  config: ClientConfigPayload;
  fileTree: FileTreePayload;
  file: FilePayload;
  cdnSession: CdnSessionPayload;
  environment: EnvironmentPayload;
  certificates: CertificatePayload[];
  environmentTables: EnvironmentTablesPayload;
  environmentKeys: EnvironmentKeysPayload;
  streamUpdate: StreamUpdatePayload;
  streamOutput: {
    slug: string;
    output: StreamOutputLine[];
    initial: boolean;
  };
  streamRedirect: {
    streamSlug: string;
  };
  streamRemove: {
    slug: string;
  };
  mcpState: McpStatePayload;
  mcpHistory: {
    entries: McpHistoryEntry[];
    /** Whether the entries replace the whole history rather than follow it. */
    initial: boolean;
  };
  mcpMessage: McpMessagePayload;
}

/** How a call of an agent was decided. */
export type McpDecision = "auto" | "once" | "session" | "always" | "denied" | "config" | "timeout" | "noUi" | "cancelled";

/** Whether an agent is accepted: waiting for an answer, for its session, always, by the configuration, or refused. */
export type McpClientStatus = "pending" | "session" | "always" | "config" | "denied";

/** What an answer to a request of an agent grants. */
export type McpAnswer = "deny" | "once" | "session" | "always";

/** A labelled value describing a call of an agent. */
export interface McpDetail {
  label: string;
  value: string;
  /** Whether the value is shown in a request only, never kept in the history. */
  secret?: boolean;
}

/** A session of an agent connected to the MCP server. */
export interface McpSessionPayload {
  id: string;
  client: string;
  version: string | null;
  connectedAt: number;
  calls: number;
  status: McpClientStatus;
}

/** An agent accepted or refused by name, by the configuration or always. */
export interface McpClientPayload {
  name: string;
  source: "allow" | "deny" | "always";
  /** When it was accepted always, null for the configuration. */
  date: number | null;
}

/** A request of an agent waiting for an answer of a person. */
export interface McpRequestPayload {
  id: string;
  /** `client` asks to accept the agent itself, `permission` to let it make a call. */
  kind: "client" | "permission";
  session: string;
  client: string;
  tool: string;
  action: McpAction | null;
  title: string;
  details: McpDetail[];
  /** Named keys the call presses in a terminal. */
  keys: string[];
  /** The command of the configuration it runs, `<section>/<project>/<slug>`, whose inputs may be changed. */
  command: string | null;
  /** The values of the inputs of that command, in order. */
  inputs: CommandInputValue[] | null;
  /** The content of a file before and after the call. */
  diff: { path: string; before: string; after: string } | null;
  notify: boolean;
  createdAt: number;
  expiresAt: number;
  /** Names what an answer for the session or always grants, null when only this call can be granted. */
  grantKey: string | null;
  /** Whether the call may be granted for the session, and always. */
  grantable: { session: boolean; always: boolean };
}

/** A call an agent may make without asking again, for its session or always. */
export interface McpGrantPayload {
  key: string;
  label: string;
  scope: "session" | "always";
  /** The session granted, null for always. */
  session: string | null;
  client: string | null;
  date: number;
}

/** A call made by an agent, as the history keeps it. */
export interface McpHistoryEntry {
  id: string;
  date: number;
  session: string;
  client: string;
  tool: string;
  /** What the call acted on, null when nothing in particular. */
  target: string | null;
  action: McpAction | null;
  details: McpDetail[];
  grantKey: string | null;
  grantLabel: string | null;
  decision: McpDecision;
  /** The setting refusing the call, for a refusal by the configuration. */
  reason: string | null;
  ok: boolean;
  /** The error, or a short summary of the result. */
  message: string | null;
  /** The arguments of the call, the private ones left out. */
  input: McpDetail[];
  duration: number;
  /** The part of the duration spent waiting for a person to answer. */
  waited: number;
  /** How the agent was accepted by a person during the call, null when it was accepted before. */
  acceptance: "session" | "always" | null;
  /** The terminal the call acted on or started. */
  terminal: string | null;
}

/** The MCP server as the interfaces show it. */
export interface McpStatePayload {
  enabled: boolean;
  port: number;
  sessions: McpSessionPayload[];
  clients: McpClientPayload[];
  pending: McpRequestPayload[];
  grants: McpGrantPayload[];
  /** The display names the agents connected since the start gave, by name. */
  titles: Record<string, string>;
}

/** A message of an agent to the person using the devtool. */
export interface McpMessagePayload {
  id: string;
  client: string;
  message: string;
  level: "info" | "warning" | "error";
  date: number;
}
