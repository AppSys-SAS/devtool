export interface AdtDefinition {
  host: string | null;
  uiPath?: string;
  shell: string | null;
  ports: {
    server: number;
    loadBalancer: number;
  };
  secure: boolean;
  notifications: boolean;
  hosts: string[];
}

export interface LoadBalancerCertificate {
  crt: string;
  key: string;
}

export interface DirectoryLoadBalancerRule {
  slug: string;
  hosts: string[];
  ports: number[];
  urls: string[];
  tls: boolean;
  path: string | null;
  prefix: string | null;
  pathNot: string | null;
  preserveHost: boolean;
}

export interface DirectoryExtra {
  slug: string;
  name: string;
  args: string[];
  detached: boolean;
  notifications: boolean;
  env: Record<string, string>;
  shell: string | null;
  killSignal: string | null;
  meta?: unknown;
}

export interface DirectoryDefinition {
  slug: string;
  name: string;
  description?: string | null;
  path: string;
  loadBalancer: Record<string, DirectoryLoadBalancerRule>;
  args: string[];
  extras: Record<string, DirectoryExtra>;
  notifications: boolean;
  env: Record<string, string>;
  shell: string | null;
  killSignal: string | null;
  meta?: unknown;
}

export interface ProjectDefinition {
  slug: string;
  name: string;
  description?: string | null;
  path: string;
  directories: Record<string, DirectoryDefinition>;
  notifications: boolean;
  meta?: unknown;
}

export interface RuntimeConfig {
  adt: AdtDefinition;
  loadBalancers: Record<string, LoadBalancerCertificate>;
  projects: Record<string, ProjectDefinition>;
  warnings: string[];
}

export interface ClientConfigPayload {
  version: string;
  warnings: string[];
  loadBalancers: string[];
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
}

/** Sign-in state of the developer on the CDN. */
export interface CdnSessionPayload {
  /** Whether the configuration declares a CDN. */
  configured: boolean;
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
  local: EnvironmentCopyPayload | null;
  /** The CDN copy, null when there is none, "unknown" when the CDN copies could not be listed. */
  remote: EnvironmentCopyPayload | null | "unknown";
  /** Dates of both copies, in ISO format, when a pull or a push last made them equal. */
  synced: { localUpdatedAt: string; remoteUpdatedAt: string } | null;
}

/** A value of a YAML key in one copy of a file. */
export interface EnvironmentKeyValuePayload {
  present: boolean;
  value: unknown;
}

/** A key whose value differs between the local and CDN copies of a YAML file. */
export interface EnvironmentKeyPayload {
  path: string[];
  local: EnvironmentKeyValuePayload;
  remote: EnvironmentKeyValuePayload;
}

/** Keys differing between the local and CDN copies of a YAML item. */
export interface EnvironmentKeysPayload {
  path: string;
  entries: EnvironmentKeyPayload[];
  error: string | null;
}

/** The copy whose value a YAML key takes. */
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

/** Configuration files of the development environment that can be edited. */
export interface ConfigFilesPayload {
  paths: string[];
}

/** A configuration file of the development environment, as its local copy stands. */
export interface ConfigFilePayload {
  path: string;
  /** Content of the local copy, null when there is none. */
  content: string | null;
  /** Last change of the local copy, in ISO format, null when there is none. */
  updatedAt: string | null;
  /** Whether the local copy was just replaced by a write. */
  saved: boolean;
  /** Whether a write was refused because the local copy changed since it was read. */
  conflict: boolean;
  /** Why the file could not be read or written. */
  error: string | null;
}

export interface WsPayloadMap {
  config: ClientConfigPayload;
  configFiles: ConfigFilesPayload;
  configFile: ConfigFilePayload;
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
