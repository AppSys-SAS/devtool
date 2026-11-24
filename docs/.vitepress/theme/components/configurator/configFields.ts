import type { ConfigPath } from './useConfigurator'

export interface FieldDefinition {
  path: ConfigPath
  label: string
  type?: 'text' | 'number' | 'checkbox' | 'select' | 'list'
  options?: readonly string[]
  placeholder?: string
  hint?: string
  defaultValue?: string | number | boolean
}

const MCP_LEVELS = ['allow', 'ask', 'deny']

export const MACHINE_FIELDS: FieldDefinition[] = [
  { path: ['workspace'], label: 'Workspace', placeholder: '~/Workspace', hint: 'Folder holding your repositories.' }
]

export const DEVTOOL_FIELDS: FieldDefinition[] = [
  { path: ['adt', 'displayName'], label: 'Display name', defaultValue: 'AppSys Devtool' },
  { path: ['adt', 'name'], label: 'Identifier', placeholder: 'acme-devtool' },
  { path: ['adt', 'icon'], label: 'Icon file', placeholder: 'assets/icon.svg' },
  { path: ['adt', 'ports', 'server'], label: 'Server port', type: 'number', defaultValue: 6730 },
  { path: ['adt', 'ports', 'loadBalancer'], label: 'Load balancer port', type: 'number', defaultValue: 6731 },
  { path: ['adt', 'sidebar', 'sort'], label: 'Sort the sidebar by', type: 'select', options: ['config', 'name', 'manual'], defaultValue: 'config' },
  { path: ['adt', 'notifications'], label: 'Notifications', type: 'checkbox', defaultValue: true },
  { path: ['adt', 'sidebar', 'environment'], label: 'Environment link', type: 'checkbox' },
  { path: ['adt', 'sidebar', 'configs'], label: 'Configs link', type: 'checkbox' },
  { path: ['adt', 'sidebar', 'login'], label: 'CDN sign-in state', type: 'checkbox' }
]

export const SECTION_FIELDS: FieldDefinition[] = [
  { path: ['name'], label: 'Name' },
  { path: ['path'], label: 'Folder', placeholder: 'relative to the workspace' },
  { path: ['description'], label: 'Description' }
]

export const CERTIFICATE_FIELDS: FieldDefinition[] = [
  { path: ['crt'], label: 'Certificate' },
  { path: ['key'], label: 'Private key' },
  { path: ['warn'], label: 'Warn days before expiry', type: 'number', defaultValue: 30 }
]

export const ENVIRONMENT_FILE_FIELDS: FieldDefinition[] = [
  { path: ['path'], label: 'Path' },
  { path: ['local'], label: 'Personal override', type: 'checkbox', defaultValue: true },
  { path: ['sync'], label: 'Synchronized', type: 'checkbox', defaultValue: true }
]

export const DATABASE_FIELDS: FieldDefinition[] = [
  { path: ['path'], label: 'Archive' },
  { path: ['engine'], label: 'Engine', type: 'select', options: ['postgres', 'mariadb', 'mongodb'] },
  { path: ['container'], label: 'Container' }
]

export const BUCKET_FIELDS: FieldDefinition[] = [
  { path: ['path'], label: 'Snapshot' },
  { path: ['bucket'], label: 'Bucket' }
]

export const S3_FIELDS: FieldDefinition[] = [
  { path: ['environment', 'folder'], label: 'Local folder', placeholder: '~/.config/appsys' },
  { path: ['environment', 's3', 'endpoint'], label: 'S3 endpoint', placeholder: 'http://localhost:9000' },
  { path: ['environment', 's3', 'accessKeyId'], label: 'S3 access key' },
  { path: ['environment', 's3', 'secretAccessKey'], label: 'S3 secret key' }
]

export const CDN_FIELDS: FieldDefinition[] = [
  { path: ['cdn', 'url'], label: 'CDN URL', placeholder: 'https://cdn.example.dev' },
  { path: ['cdn', 'openid', 'issuer'], label: 'OpenID issuer', placeholder: 'https://auth.example.dev' },
  { path: ['cdn', 'openid', 'clientId'], label: 'Client ID', placeholder: 'devtool' },
  { path: ['cdn', 'openid', 'name'], label: 'Sign-in name', placeholder: 'My SSO' }
]

export const AGENT_FIELDS: FieldDefinition[] = [
  { path: ['adt', 'mcp', 'enabled'], label: 'Enable the MCP server', type: 'checkbox' },
  { path: ['adt', 'mcp', 'timeout'], label: 'Seconds to answer', type: 'number', defaultValue: 120 },
  ...['read', 'run', 'input', 'control', 'write'].map((action): FieldDefinition => (
    { path: ['adt', 'mcp', 'default', action], label: `Default level: ${action}`, type: 'select', options: MCP_LEVELS }
  )),
  { path: ['adt', 'mcp', 'clients', 'allow'], label: 'Agents always accepted', type: 'list', placeholder: 'claude-code, codex' },
  { path: ['adt', 'mcp', 'shell', 'level'], label: 'Shell commands', type: 'select', options: MCP_LEVELS, defaultValue: 'deny' },
  { path: ['adt', 'mcp', 'shell', 'allow'], label: 'Shell commands allowed', type: 'list', placeholder: 'git status*, pnpm test*' }
]

export const PROJECT_FIELDS: FieldDefinition[] = [
  { path: ['name'], label: 'Name' },
  { path: ['path'], label: 'Folder', placeholder: 'the slug', hint: 'Relative to the section folder.' },
  { path: ['description'], label: 'Description' }
]

export const COMMAND_FIELDS: FieldDefinition[] = [
  { path: ['name'], label: 'Name' },
  { path: ['startWithSection'], label: 'Start with the section', type: 'checkbox' }
]

export const SERVICE_FIELDS: FieldDefinition[] = [
  { path: ['host'], label: 'Host', placeholder: 'web.example.dev' },
  { path: ['target'], label: 'Target', placeholder: '5173, host:port or URL' },
  { path: ['tls'], label: 'Forward as HTTPS', type: 'checkbox' },
  { path: ['access'], label: 'Access', type: 'select', options: ['local', 'network'], defaultValue: 'local' }
]

export const FILES_FIELDS: FieldDefinition[] = [
  { path: ['name'], label: 'Name' },
  { path: ['path'], label: 'Folder' },
  { path: ['type'], label: 'Type', type: 'select', options: ['files', 'agentSkills'], defaultValue: 'files' }
]

export const INTEGRATION_FIELDS: FieldDefinition[] = [
  { path: ['name'], label: 'Name' },
  { path: ['type'], label: 'Type', type: 'select', options: ['web', 'pullRequests', 'issues'], defaultValue: 'web' },
  { path: ['url'], label: 'URL', placeholder: 'page, or repository by default' },
  { path: ['icon'], label: 'Icon', placeholder: 'lucide:git-pull-request' },
  { path: ['token'], label: 'Token', placeholder: '{{ $(gh auth token) }}' }
]
