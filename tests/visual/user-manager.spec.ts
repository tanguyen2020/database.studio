import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// U1 — PostgreSQL User Manager. The "Users & privileges" Explorer toolbar button
// opens the User Manager tab (NOT the old Admin view) with the pgAdmin-style
// Login/Group Roles list, General/Membership/Privileges tabs, the Create Role
// popup, and the per-schema privilege grid with presets.
async function openManager(page: import('@playwright/test').Page) {
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await page.getByTitle(/Users & privileges: /).click()
  await page.waitForTimeout(500)
}

test('user manager: PG shell lists roles and shows attributes', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await openManager(page)

  await expect(page.getByRole('tab', { name: /Users · / }).first()).toBeVisible()
  await expect(page.getByText('Login/Group Roles').first()).toBeVisible()
  await expect(page.getByRole('option', { name: /postgres/ }).first()).toBeVisible()
  await expect(page.getByRole('option', { name: /app_user/ }).first()).toBeVisible()

  // select app_user → General tab shows attribute labels (not raw column names)
  await page.getByRole('option', { name: /app_user/ }).first().click()
  await page.waitForTimeout(150)
  await expect(page.getByText('Can login', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Superuser', { exact: true }).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('user manager: New Role opens a popup dialog (not a tab)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await openManager(page)

  const tabsBefore = await page.getByRole('tab').count()
  await page.getByRole('button', { name: '+ New Role' }).click()
  await page.waitForTimeout(300)
  // popup, not a new tab
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByText('Create Login/Group Role').first()).toBeVisible()
  expect(await page.getByRole('tab').count()).toBe(tabsBefore)

  // preview updates when a name is typed; primary button reflects "Can login?"
  await page.getByRole('dialog').locator('input').first().fill('spec_user')
  await page.waitForTimeout(150)
  await expect(page.getByText(/CREATE ROLE "spec_user" LOGIN/).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create login role' })).toBeVisible()

  // backdrop click does NOT close
  await page.mouse.click(6, 6)
  await page.waitForTimeout(150)
  await expect(page.getByRole('dialog')).toBeVisible()
  // Cancel closes
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.waitForTimeout(150)
  await expect(page.getByRole('dialog')).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('user manager: privilege grid preset queues GRANT statements', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await openManager(page)

  await page.getByRole('option', { name: /app_user/ }).first().click()
  await page.waitForTimeout(150)
  await page.getByRole('tab', { name: 'Privileges' }).click()
  await page.waitForTimeout(200)

  // grid shows the public schema row + preset buttons
  await expect(page.getByRole('cell', { name: 'public' }).first()).toBeVisible()
  // apply Read-only preset → pending changes appear with the exact GRANT SQL
  await page.getByRole('button', { name: 'R', exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/Pending changes/).first()).toBeVisible()
  await expect(page.getByText(/GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "app_user"/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
