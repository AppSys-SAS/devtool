import { strToU8, zipSync } from 'fflate'
import { Document, isScalar, visit } from 'yaml'

export type SplitMode = 'single' | 'split'

export interface ConfigFile {
  path: string
  content: string
}

const SCHEMA_URL = 'https://appsys-sas.github.io/devtool/schema/config.json'
const SPLIT_INCLUDES = ['config/*.yml', 'projects/*.yml']

/**
 * Serializes a configuration fragment as YAML, short lists of scalars written on one line.
 * @param value The fragment to serialize.
 * @returns The YAML text, headed by the schema line editors read for completion.
 */
export function toYaml (value: Record<string, unknown>): string {
  const document = new Document(value)
  visit(document, {
    Seq (_, node) {
      if (node.items.length <= 8 && node.items.every(item => isScalar(item))) {
        node.flow = true
      }
    }
  })
  return `# yaml-language-server: $schema=${SCHEMA_URL}\n${document.toString({ lineWidth: 0 })}`
}

/**
 * Splits a configuration into the files a team keeps: the shared file, optionally one file for the sections and
 * one per project linked by `include`, and the personal file holding the workspace.
 * @param config The whole configuration.
 * @param mode `single` keeps everything shared in config.yml, `split` moves sections and projects to their own files.
 * @returns The files, config.yml first.
 */
export function buildFiles (config: Record<string, unknown>, mode: SplitMode): ConfigFile[] {
  const { workspace, sections, projects, ...shared } = config
  const files: ConfigFile[] = []

  if (mode === 'single') {
    files.push({ path: 'config.yml', content: toYaml({ ...shared, ...defined({ sections, projects }) }) })
  } else {
    files.push({ path: 'config.yml', content: toYaml({ include: SPLIT_INCLUDES, ...shared }) })
    if (sections !== undefined) {
      files.push({ path: 'config/sections.yml', content: toYaml({ sections }) })
    }
    for (const [slug, project] of Object.entries(asRecord(projects))) {
      files.push({ path: `projects/${slug}.yml`, content: toYaml({ projects: { [slug]: project } }) })
    }
  }

  if (workspace !== undefined) {
    files.push({ path: 'config.local.yml', content: toYaml({ workspace }) })
  }
  return files
}

/**
 * Packs files into a zip archive.
 * @param files The files, by path.
 * @returns The bytes of the archive.
 */
export function zipFiles (files: ConfigFile[]): Uint8Array {
  return zipSync(Object.fromEntries(files.map(file => [file.path, strToU8(file.content)])))
}

/**
 * Narrows an unknown value to a plain object.
 * @param value Any value.
 * @returns The value when it is a plain object, else an empty object.
 */
export function asRecord (value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * Drops the undefined entries of an object.
 * @param values Entries that may be undefined.
 * @returns The defined entries only.
 */
function defined (values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))
}
