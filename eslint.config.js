import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import vue from 'eslint-plugin-vue'
import globals from 'globals'
import ts from 'typescript-eslint'

const unusedVariables = ['warn', {
  argsIgnorePattern: '^_',
  caughtErrorsIgnorePattern: '^_',
  destructuredArrayIgnorePattern: '^_',
  varsIgnorePattern: '^_'
}]

const typeScriptFiles = ['**/*.ts']
const uiFiles = ['apps/ui/**/*.ts', 'apps/ui/**/*.vue']

export default [
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      'apps/*/lib',
      'packages/*/lib',
      'coverage',
      'test-results',
      'playwright-report'
    ]
  },
  js.configs.recommended,
  stylistic.configs.customize({
    indent: 2,
    quotes: 'single',
    semi: false,
    braceStyle: '1tbs',
    arrowParens: false,
    blockSpacing: true,
    quoteProps: 'consistent',
    commaDangle: 'never'
  }),
  {
    rules: {
      'no-unused-vars': unusedVariables,
      '@stylistic/space-before-function-paren': ['error', 'always'],
      '@stylistic/arrow-parens': ['error', 'as-needed'],
      'curly': ['error', 'multi-line'],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'IfStatement:not(:has(BlockStatement)):not(:has(ReturnStatement, ContinueStatement, ThrowStatement, BreakStatement))',
          message: 'Braceless if statements are only allowed for return, continue, throw and break.'
        },
        {
          selector: 'IfStatement:not(:has(BlockStatement)) > ExpressionStatement > AssignmentExpression',
          message: 'Assignments in braceless if statements are not allowed.'
        }
      ],
      'no-async-promise-executor': 'error',
      'no-promise-executor-return': 'error',
      'prefer-promise-reject-errors': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error'
    }
  },
  ...defineConfigWithVueTs(
    vue.configs['flat/recommended'],
    vueTsConfigs.recommended
  ),
  {
    files: uiFiles,
    rules: {
      'vue/require-explicit-emits': 'off',
      'vue/no-mutating-props': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/max-attributes-per-line': ['error', { singleline: 3 }],
      'vue/component-definition-name-casing': ['error', 'kebab-case'],
      'vue/no-unused-vars': ['warn', { ignorePattern: '^_' }],
      'vue/no-unused-properties': ['warn', {
        groups: ['data', 'props', 'computed', 'methods'],
        deepData: false,
        ignorePublicMembers: false
      }]
    },
    languageOptions: {
      globals: globals.browser
    }
  },
  ...ts.configs.recommendedTypeChecked.map(config => ({ files: typeScriptFiles, ...config })),
  ...ts.configs.stylisticTypeChecked.map(config => ({ files: typeScriptFiles, ...config })),
  {
    files: typeScriptFiles,
    languageOptions: {
      parserOptions: {
        project: ['./apps/*/tsconfig.json', './packages/*/tsconfig.json', './tsconfig.eslint.json'],
        projectService: false,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': unusedVariables,
      '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }],
      '@typescript-eslint/no-explicit-any': ['error', { ignoreRestArgs: true }],
      '@typescript-eslint/prefer-nullish-coalescing': ['error', { ignorePrimitives: { string: true } }],
      '@typescript-eslint/return-await': ['error', 'in-try-catch']
    }
  },
  {
    ignores: uiFiles,
    rules: {
      'no-console': 'warn'
    },
    languageOptions: {
      globals: globals.node
    }
  },
  {
    files: ['**/tests/**/*.ts', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-empty-function': 'off'
    }
  },
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module'
    }
  }
]
