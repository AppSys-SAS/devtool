import { copyFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'
import { groupIconMdPlugin, groupIconVitePlugin } from 'vitepress-plugin-group-icons'
import { exampleArchiveAt, zipExamples } from './examples.js'

const require = createRequire(import.meta.url)
const examplesFolder = fileURLToPath(new URL('../examples', import.meta.url))
const schemaFile = require.resolve('@appsys/devtool-config/schema/config.schema.json')
const repository = 'https://github.com/AppSys-SAS/devtool'

export default defineConfig({
  title: 'Devtool',
  titleTemplate: ':title · AppSys Devtool',
  description: 'A local development environment driven by one YAML file: terminals, HTTPS services, shared environment and AI agents.',
  lang: 'en-US',
  base: '/devtool/',
  cleanUrls: true,
  srcExclude: ['examples/*/**'],
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/devtool/logo.svg' }],
    ['meta', { name: 'theme-color', content: '#20085e' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Lato:wght@400;700&family=Poppins:wght@500;600;700&display=swap' }]
  ],
  markdown: {
    config (md) {
      md.use(groupIconMdPlugin)
    }
  },
  vite: {
    plugins: [
      groupIconVitePlugin(),
      {
        name: 'devtool-example-archives',
        /**
         * Serves the zip archives of the examples from the development server, built on each request.
         * @param server The development server.
         */
        configureServer (server) {
          server.middlewares.use((req, res, next) => {
            exampleArchiveAt(examplesFolder, req.url ?? '').then(archive => {
              if (!archive) {
                next()
                return
              }
              res.setHeader('Content-Type', 'application/zip')
              res.end(archive)
            }, next)
          })
        }
      }
    ]
  },
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'Devtool',
    nav: [
      { text: 'Guide', link: '/guide/introduction', activeMatch: '/guide/' },
      { text: 'Configuration', link: '/configuration/overview', activeMatch: '/configuration/' },
      { text: 'Configurator', link: '/configuration/configurator' },
      { text: 'Agents', link: '/agents/coding-agents', activeMatch: '/agents/' },
      { text: 'Examples', link: '/examples/', activeMatch: '/examples/' },
      { text: 'CLI', link: '/reference/cli', activeMatch: '/reference/' }
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Introduction', link: '/guide/introduction' },
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Concepts', link: '/guide/concepts' }
        ]
      },
      {
        text: 'Configuration',
        items: [
          { text: 'Files and merging', link: '/configuration/overview' },
          { text: 'Configurator', link: '/configuration/configurator' },
          { text: 'The devtool (adt)', link: '/configuration/devtool' },
          { text: 'Sections', link: '/configuration/sections' },
          { text: 'Projects', link: '/configuration/projects' },
          { text: 'Commands and scripts', link: '/configuration/commands' },
          { text: 'Automation and secrets', link: '/configuration/automation' },
          { text: 'Files', link: '/configuration/files' },
          { text: 'Integrations', link: '/configuration/integrations' },
          { text: 'Sign-in', link: '/configuration/auth' },
          {
            text: 'Network',
            collapsed: true,
            items: [
              { text: 'Services', link: '/configuration/services' },
              { text: 'Network and DNS', link: '/configuration/network' },
              { text: 'Certificates', link: '/configuration/certificates' }
            ]
          },
          {
            text: 'Environment',
            collapsed: false,
            items: [
              { text: 'Overview', link: '/configuration/environment/' },
              { text: 'Backends', link: '/configuration/environment/backends' },
              {
                text: 'Backend types',
                collapsed: false,
                items: [
                  { text: 'CDN', link: '/configuration/environment/cdn' },
                  { text: 'S3', link: '/configuration/environment/s3' },
                  { text: 'SFTP', link: '/configuration/environment/sftp' },
                  { text: 'git', link: '/configuration/environment/git' },
                  { text: 'scripts', link: '/configuration/environment/scripts' }
                ]
              },
              { text: 'Encryption', link: '/configuration/environment/encryption' }
            ]
          },
          { text: 'Agent permissions (MCP)', link: '/configuration/mcp' },
          { text: 'All keys', link: '/configuration/reference' }
        ]
      },
      {
        text: 'Agents',
        items: [
          { text: 'Coding agents', link: '/agents/coding-agents' },
          { text: 'MCP server', link: '/agents/mcp-server' },
          { text: 'Agent skills', link: '/agents/skills' }
        ]
      },
      {
        text: 'Examples',
        items: [
          { text: 'Overview', link: '/examples/' },
          {
            text: 'Environment',
            items: [
              { text: 'Run a CDN server', link: '/examples/cdn-server' },
              { text: 'Backend scripts', link: '/examples/backend-scripts' }
            ]
          },
          {
            text: 'Integrations',
            items: [
              { text: 'Recommended tools', link: '/examples/dev-tools' }
            ]
          }
        ]
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI', link: '/reference/cli' },
          { text: 'Contributing', link: '/reference/contributing' }
        ]
      }
    ],
    outline: { level: [2, 3] },
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: repository }],
    editLink: {
      pattern: `${repository}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub'
    },
    footer: {
      message: 'Released under the <a href="https://github.com/AppSys-SAS/devtool/blob/main/LICENSE">Apache License 2.0</a>.',
      copyright: 'Made by <a href="https://appsys.digital">AppSys</a>'
    }
  },
  /**
   * Publishes the configuration schema and a zip archive of each example next to the built site.
   * @param site The resolved site configuration.
   */
  async buildEnd (site) {
    const target = path.join(site.outDir, 'schema')
    await mkdir(target, { recursive: true })
    await copyFile(schemaFile, path.join(target, 'config.json'))
    await zipExamples(path.join(site.srcDir, 'examples'), path.join(site.outDir, 'examples'))
  }
})
