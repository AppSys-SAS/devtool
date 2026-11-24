import { expect, test } from '@playwright/test'

test.describe('sidebar', () => {
  test('lists the sections and their projects, leaving out the invalid ones', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByRole('link', { name: 'Demo' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'App', exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Ghost' })).toHaveCount(0)
  })

  test('opens a project with its main command', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'App', exact: true }).click()

    await expect(page).toHaveURL(/\/p\/demo\/d\/app$/)
    await expect(page.getByRole('button', { name: 'sh -c echo hello-e2e', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Hello sh -c echo hello-e2e' })).toBeVisible()
  })
})
