import fs from 'node:fs/promises'
import path from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { load } from 'js-yaml'
import { beforeAll, describe, expect, it } from 'vitest'
import type { ValidateFunction } from 'ajv/dist/2020.js'

const root = path.resolve(import.meta.dirname, '../../../..')
let validate: ValidateFunction

/**
 * Reads a YAML file of the repository.
 * @param file Path from the repository root.
 * @returns The parsed document.
 */
async function readYaml (file: string): Promise<unknown> {
  return load(await fs.readFile(path.join(root, file), 'utf8'))
}

beforeAll(async () => {
  const schema = JSON.parse(await fs.readFile(path.join(root, 'packages/config/schema/config.schema.json'), 'utf8')) as object
  validate = new Ajv2020({ allErrors: true, allowUnionTypes: true }).compile(schema)
})

describe('config schema', () => {
  it('accepts the configuration of the end-to-end tests', async () => {
    expect(validate(await readYaml('e2e/fixtures/devtool/config.yml')), JSON.stringify(validate.errors)).toBe(true)
  })

  it('accepts the short and long forms of a configuration', () => {
    const config = {
      workspace: '~/Workspace',
      include: ['projects/*.yml'],
      adt: { displayName: 'Acme Devtool', mcp: { enabled: true, default: { read: 'allow', run: 'ask' }, shell: { level: 'ask', allow: ['git status*'] } } },
      sections: { api: { path: 'api', icons: ['integration:pulls'], integrations: { pulls: { name: 'Pull requests', type: 'pullRequests', agentReview: true } } } },
      projects: {
        web: {
          section: 'api',
          default: { action: 'command:dev', trigger: 'row' },
          commands: { dev: { args: ['pnpm', 'dev', { name: 'mode', choices: ['dev', { label: 'Production', value: 'prd' }] }], startWithSection: true } },
          services: { web: { host: 'web.example.dev', target: 5173, tls: true } },
          scripts: ['scripts', { path: 'tools', only: ['*.sh'] }],
          files: { skills: { path: '.claude/skills', type: 'agentSkills' } }
        }
      },
      environment: {
        backends: {
          team: { type: 'cdn', url: 'https://files.example.dev', default: true },
          archive: { type: 's3', bucket: 'acme-dev', pathStyle: true, encryption: { key: '{{ op://dev/env/key }}' } },
          nas: { type: 'sftp', host: 'nas.example.dev', username: 'dev' },
          history: { type: 'git', url: 'git@example.dev:acme/env.git' },
          custom: { type: 'scripts', list: ['./backend.sh', 'list'], download: ['./backend.sh', 'download', '%{ADT:PATH}', '%{ADT:FILE}'], upload: ['./backend.sh', 'upload', '%{ADT:PATH}', '%{ADT:FILE}'], remove: ['./backend.sh', 'remove', '%{ADT:PATH}'] }
        },
        encryption: [{ paths: ['secrets/**'], prompt: true }],
        files: ['devtool/config.yml', { path: 'api/config.yml', local: false, backend: 'nas', encryption: { password: 'x' } }],
        databases: [{ path: 'api/db.gz', engine: 'postgres', container: 'postgres', backend: 'archive' }]
      }
    }
    expect(validate(config), JSON.stringify(validate.errors)).toBe(true)
  })

  it('rejects unknown keys and invalid values', () => {
    expect(validate({ projects: { web: { comands: {} } } })).toBe(false)
    expect(validate({ adt: { sidebar: { sort: 'random' } } })).toBe(false)
    expect(validate({ projects: { web: { commands: { dev: { name: 'Dev' } } } } })).toBe(false)
    expect(validate({ integrations: { mail: { name: 'Mail' } } })).toBe(false)
    expect(validate({ cdn: { url: 'https://files.example.dev' } })).toBe(false)
    expect(validate({ environment: { backends: { team: { type: 'cdn', url: 'https://files.example.dev', bucket: 'x' } } } })).toBe(false)
    expect(validate({ environment: { backends: { team: { type: 'ftp' } } } })).toBe(false)
    expect(validate({ environment: { encryption: [{ paths: ['*'], key: 'a', prompt: true }] } })).toBe(false)
  })
})
