import { expect, test } from '@playwright/test'

test.describe('terminal', () => {
  test('runs the main command of a project and shows its output', async ({ page }) => {
    await page.goto('/p/demo/d/app')
    await page.getByRole('button', { name: 'sh -c echo hello-e2e', exact: true }).click()

    await expect(page.locator('.xterm-rows')).toContainText('hello-e2e')
  })
})
