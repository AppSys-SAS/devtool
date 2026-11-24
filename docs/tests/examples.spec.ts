import fs from 'node:fs/promises'
import path from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { glob } from 'glob'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const docs = path.resolve(import.meta.dirname, '..')
const CONFIG_TITLE = /^(config(\.local)?\.yml|config\/.+\.yml|projects\/.+\.yml)$/
const YAML_BLOCK = /^([ \t]*)```ya?ml(?:\s+\[([^\]]+)\])?[^\n]*\n([\s\S]*?)^\1```/gm

const schema = JSON.parse(await fs.readFile(path.resolve(docs, '../packages/config/schema/config.schema.json'), 'utf8')) as object
const validate = new Ajv2020({ allErrors: true, allowUnionTypes: true }).compile(schema)
const pages = await glob('**/*.md', { cwd: docs, ignore: ['**/node_modules/**', '.vitepress/**'] })

describe('configuration examples of the documentation', () => {
  for (const page of pages.sort()) {
    it(`${page} holds valid examples`, async () => {
      const markdown = await fs.readFile(path.join(docs, page), 'utf8')
      for (const [, indent, title, block] of markdown.matchAll(YAML_BLOCK)) {
        if (title && !CONFIG_TITLE.test(title)) {
          continue
        }
        const source = block.split('\n').map(line => line.slice(indent.length)).join('\n')
        const example = parse(source) as unknown
        expect(validate(example), `${page}: ${JSON.stringify(validate.errors)}\n${source}`).toBe(true)
      }
    })
  }
})
