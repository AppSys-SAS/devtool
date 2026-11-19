/** Who reaches a host through the load balancer: clients of this machine only, or any client. */
export type HostAccess = "local" | "network";

export interface AdtDefinition {
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
  warnings: string[];
  loadBalancers: string[];
  integrations: IntegrationDefinition[];
  projects: Record<string, ProjectDefinition>;
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
}
