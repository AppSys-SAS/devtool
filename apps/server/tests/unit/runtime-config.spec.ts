import { describe, expect, it } from 'vitest'
import { createRuntimeConfig } from '../../src/index.js'

const OPTIONS = { serverPort: undefined, loadBalancerPort: undefined, ssl: null, uiPath: null }

/**
 * Builds the runtime configuration of the sections and projects of a merged configuration.
 * @param raw - The merged configuration files.
 * @returns The sections of the runtime configuration, by slug.
 */
function sectionsOf (raw: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return createRuntimeConfig(raw, OPTIONS).projects as Record<string, Record<string, unknown>>
}

describe('createRuntimeConfig', () => {
  it('places a project naming no section in the uncategorized section, under the workspace', () => {
    const sections = sectionsOf({
      workspace: '/work',
      sections: { api: { path: '/work/api' } },
      projects: { api: { section: 'api' }, notes: {}, docs: { section: 'missing' } }
    })
    expect(Object.keys(sections)).toEqual(['api', 'uncategorized'])
    expect(sections.uncategorized).toMatchObject({ name: 'Uncategorized', path: '/work', projects: ['notes', 'docs'] })
    expect((sections.uncategorized.directories as Record<string, Record<string, unknown>>).docs.section).toBe('missing')
  })

  it('places the uncategorized section at the section path of the configuration', () => {
    const sections = sectionsOf({ workspace: '/work', sectionPath: 'acme', sections: { api: { path: '/work/api' } }, projects: { notes: {} } })
    expect(sections.uncategorized.path).toBe('/work/acme')
  })

  it('keeps an uncategorized section the configuration declares', () => {
    const sections = sectionsOf({ workspace: '/work', sections: { uncategorized: { path: '/work/misc' } }, projects: { notes: {} } })
    expect(sections.uncategorized).toMatchObject({ path: '/work/misc', projects: ['notes'] })
    expect(sections.uncategorized.name).toBeUndefined()
  })

  it('keeps the environment of a project when its main command declares one', () => {
    const sections = sectionsOf({
      workspace: '/work',
      sections: { api: { path: '/work/api' } },
      projects: { api: { section: 'api', env: { STAGE: 'dev' }, default: { action: 'command:dev' }, commands: { dev: { args: ['pnpm', 'dev'], env: { PORT: '3000' } } } } }
    })
    expect((sections.api.directories as Record<string, Record<string, unknown>>).api).toMatchObject({ args: ['pnpm', 'dev'], env: { STAGE: 'dev' } })
  })
})
