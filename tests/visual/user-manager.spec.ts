import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// U0 — User Manager shell. The "Users & privileges" Explorer toolbar button is
// disabled until a schema/database is selected, then it opens the User Manager
// tab (NOT the old Admin view) listing the connection's principals.
test('user manager: toolbar opens the shell and lists principals', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // select a Postgres connection, then the public schema → toolbar enables
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().click()
  await page.waitForTimeout(200)

  // click the Users & privileges toolbar button
  await page.getByTitle(/Users & privileges: /).click()
  await page.waitForTimeout(500)

  // a Users tab opened
  await expect(page.getByRole('tab', { name: /Users · / }).first()).toBeVisible()
  // shell shows the native group label + the principal list from usersView
  await expect(page.getByText('Login/Group Roles').first()).toBeVisible()
  await expect(page.getByRole('option', { name: 'postgres' }).first()).toBeVisible()
  await expect(page.getByRole('option', { name: 'app_user' }).first()).toBeVisible()

  // selecting a principal shows its detail
  await page.getByRole('option', { name: 'app_user' }).first().click()
  await page.waitForTimeout(150)
  await expect(page.getByText('rolcanlogin').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
