import os from 'node:os'
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'

process.env.E2E_FOLDER ??= path.join(os.tmpdir(), 'devtool-e2e')

const baseURL = 'http://127.0.0.1:16730'

export default defineConfig({
  testDir: './e2e/tests',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } }
  ],
  webServer: {
    command: 'node e2e/serve.mjs',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000
  }
})
