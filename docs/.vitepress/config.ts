import { copyFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { defineConfig } from 'vitepress'
import { groupIconMdPlugin, groupIconVitePlugin } from 'vitepress-plugin-group-icons'

const require = createRequire(import.meta.url)
const schemaFile = require.resolve('@appsys/devtool-config/schema/config.schema.json')
const repository = 'https://github.com/AppSys-SAS/devtool'

export default defineConfig({
  title: 'Devtool',
  titleTemplate: ':title · AppSys Devtool',
  description: 'A local development environment driven by one YAML file: terminals, HTTPS services, shared environment and AI agents.',
  lang: 'en-US',
  base: '/devtool/',
  cleanUrls: true,
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
    plugins: [groupIconVitePlugin()]
  },
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'Devtool',
    nav: [
      { text: 'Guide', link: '/guide/introduction', activeMatch: '/guide/' },
      { text: 'Configuration', link: '/configuration/overview', activeMatch: '/configuration/' },
      { text: 'Configurator', link: '/configuration/configurator' },
      { text: 'Agents', link: '/agents/mcp-server', activeMatch: '/agents/' },
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
          { text: 'Services', link: '/configuration/services' },
          { text: 'Network and DNS', link: '/configuration/network' },
          { text: 'Certificates', link: '/configuration/certificates' },
          { text: 'Integrations', link: '/configuration/integrations' },
          { text: 'Files', link: '/configuration/files' },
          { text: 'Environment', link: '/configuration/environment' },
          { text: 'CDN', link: '/configuration/cdn' },
          { text: 'Agent permissions (MCP)', link: '/configuration/mcp' },
          { text: 'All keys', link: '/configuration/reference' }
        ]
      },
      {
        text: 'Agents',
        items: [
          { text: 'MCP server', link: '/agents/mcp-server' },
          { text: 'Agent skills', link: '/agents/skills' }
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
   * Publishes the configuration schema next to the built site.
   * @param site The resolved site configuration.
   */
  async buildEnd (site) {
    const target = path.join(site.outDir, 'schema')
    await mkdir(target, { recursive: true })
    await copyFile(schemaFile, path.join(target, 'config.json'))
  }
})
