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

export interface WsPayloadMap {
  config: ClientConfigPayload;
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
