import schema from '@appsys/devtool-config/schema/config.schema.json'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ErrorObject } from 'ajv/dist/2020.js'

export interface ConfigProblem {
  path: string
  message: string
}

const validate = new Ajv2020({ allErrors: true, allowUnionTypes: true, verbose: true }).compile(schema)
const COMBINATOR_KEYWORDS = new Set(['anyOf', 'oneOf', 'if', 'not'])

/**
 * Validates a configuration against the devtool schema.
 * @param config The configuration to check.
 * @returns One readable problem per setting, empty when the configuration is valid.
 */
export function validateConfig (config: unknown): ConfigProblem[] {
  if (validate(config)) {
    return []
  }

  const errors = validate.errors ?? []
  const problems = new Map<string, ConfigProblem>()
  const describedChoices = errors.filter(error => COMBINATOR_KEYWORDS.has(error.keyword) && hasDescription(error))
  for (const error of [...describedChoices, ...errors.filter(error => !COMBINATOR_KEYWORDS.has(error.keyword))]) {
    const path = error.instancePath.slice(1).replaceAll('/', '.') || '(root)'
    if (!problems.has(path)) {
      problems.set(path, { path, message: describe(error) })
    }
  }
  return [...problems.values()]
}

/**
 * Tells whether the schema holding an error describes the expected value.
 * @param error The error reported by the validator.
 * @returns True when the schema has a description.
 */
function hasDescription (error: ErrorObject): boolean {
  return typeof (error.parentSchema as { description?: unknown } | undefined)?.description === 'string'
}

/**
 * Turns a schema error into a sentence.
 * @param error The error reported by the validator.
 * @returns A short message about the setting.
 */
function describe (error: ErrorObject): string {
  const params = error.params as Record<string, unknown>
  switch (error.keyword) {
    case 'additionalProperties':
    case 'unevaluatedProperties':
      return `unknown key "${String(params.additionalProperty ?? params.unevaluatedProperty)}"`
    case 'required':
      return `"${String(params.missingProperty)}" is required`
    case 'enum':
      return `must be one of ${(params.allowedValues as unknown[]).join(', ')}`
    case 'anyOf':
    case 'oneOf':
      return `is invalid. Expected: ${String((error.parentSchema as { description: string }).description)}`
    default:
      return error.message ?? 'is invalid'
  }
}
