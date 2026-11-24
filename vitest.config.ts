import path from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    clearMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['{apps,packages}/*/tests/unit/**/*.spec.ts', 'docs/tests/**/*.spec.ts'],
          exclude: [...configDefaults.exclude, 'apps/ui/**']
        }
      },
      {
        extends: true,
        resolve: {
          alias: { '@': path.resolve(import.meta.dirname, 'apps/ui/src') }
        },
        test: {
          name: 'ui',
          environment: 'node',
          include: ['apps/ui/tests/unit/**/*.spec.ts']
        }
      }
    ]
  }
})
