import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'

const folder = process.env.E2E_FOLDER ?? ''
const configPath = path.join(folder, 'devtool', 'config.yml')

test.describe('reconfiguration', () => {
  let original: string

  test.beforeEach(async () => {
    original = await readFile(configPath, 'utf8')
  })

  test.afterEach(async () => {
    await writeFile(configPath, original)
  })

  test('shows a project added to the configuration file once the configuration is rescanned', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'App', exact: true })).toBeVisible()

    await mkdir(path.join(folder, 'workspace', 'demo', 'api'), { recursive: true })
    await writeFile(configPath, `${original}  api:\n    section: demo\n    name: Api\n    path: api\n`)
    await page.getByRole('button', { name: 'Rescan Config Paths' }).click()

    await expect(page.getByRole('link', { name: 'Api', exact: true })).toBeVisible()
  })
})
