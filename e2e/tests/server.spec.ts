import { expect, test } from '@playwright/test'

test.describe('server page', () => {
  test('shows the status of the configuration and its warnings', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByText('Configuration status and validation warnings.')).toBeVisible()
    await expect(page.getByText(/projects\[demo\]\.directories\[ghost\]\.path: ENOENT/)).toBeVisible()
    await expect(page.getByRole('link', { name: '1 config warning' })).toBeVisible()
  })
})
