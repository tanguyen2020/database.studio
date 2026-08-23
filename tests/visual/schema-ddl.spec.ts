import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Engines where a schema is its own object (PG/MSSQL/Oracle) get Rename + Drop on
// the schema node — the tree used to offer them only for schema-as-database
// engines (MySQL/MariaDB/ClickHouse), so PG/MSSQL schemas had no way to be
// renamed or dropped from the explorer.

async function openPgTree(page: import('@playwright/test').Page) {
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.waitForTimeout(300)
}

test('schema node: Rename Schema runs ALTER SCHEMA and the tree shows the new name', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await openPgTree(page)

  await page.getByRole('treeitem', { name: /public/ }).first().click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Rename Schema…' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Drop Schema…' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Rename Schema…' }).click()

  const dialog = page.getByRole('dialog', { name: 'Rename schema' })
  await expect(dialog).toBeVisible()
  // the popup is the place it happens — no SQL tab parked for the user to run
  await expect(page.getByRole('tab', { name: /Rename schema/ })).toHaveCount(0)
  const input = dialog.locator('input#rn-db')
  await expect(input).toBeFocused()

  // same name → Confirm stays disabled
  await expect(dialog.getByRole('button', { name: 'Confirm' })).toHaveAttribute('aria-disabled', 'true')

  await input.fill('app_v2')
  await expect(dialog.getByText('ALTER SCHEMA "public" RENAME TO "app_v2";')).toBeVisible()

  // backdrop click must not close a form popup
  await page.mouse.click(8, 8)
  await expect(dialog).toBeVisible()

  await dialog.getByRole('button', { name: 'Confirm' }).click()
  await expect(dialog).toBeHidden({ timeout: 10_000 })
  const sql = await page.evaluate(() => (window as unknown as { __ipcLastSql?: string }).__ipcLastSql)
  expect(sql).toBe('ALTER SCHEMA "public" RENAME TO "app_v2";')

  // the tree re-read the server: the schema is listed under its new name
  await expect(page.getByRole('treeitem', { name: /app_v2/ }).first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('treeitem', { name: /^public/ })).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('schema node: Drop Schema shows the refusal, then CASCADE removes it', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await openPgTree(page)

  await page.getByRole('treeitem', { name: /public/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Drop Schema…' }).click()

  const dialog = page.getByRole('dialog', { name: 'Drop schema' })
  await expect(dialog).toBeVisible()
  // defaults to RESTRICT — the safe statement
  await expect(dialog.getByText('DROP SCHEMA IF EXISTS "public" RESTRICT;')).toBeVisible()

  // Cancel runs nothing
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  expect(await page.evaluate(() => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.exec_statement ?? 0)).toBe(0)

  await page.getByRole('treeitem', { name: /public/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Drop Schema…' }).click()
  await expect(dialog).toBeVisible()

  // the server refuses a non-empty schema — the reason stays IN the dialog
  await dialog.getByRole('button', { name: 'Drop schema' }).click()
  await expect(dialog.getByText(/other objects depend on it/)).toBeVisible({ timeout: 10_000 })
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('treeitem', { name: /public/ }).first()).toBeVisible()

  // tick CASCADE → statement changes → the drop goes through and the tree loses it
  await dialog.getByRole('checkbox').check()
  await expect(dialog.getByText('DROP SCHEMA IF EXISTS "public" CASCADE;')).toBeVisible()
  await dialog.getByRole('button', { name: 'Drop schema' }).click()
  await expect(dialog).toBeHidden({ timeout: 10_000 })
  await expect(page.getByRole('treeitem', { name: /^public/ })).toHaveCount(0, { timeout: 10_000 })

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('MSSQL: a schema cannot be renamed in place, and DROP SCHEMA has no CASCADE', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /MSSQL/ }).first().click()
  await page.waitForTimeout(400)
  // the demo MSSQL profile starts disconnected
  await page.getByRole('button', { name: 'Connect', exact: true }).first().click()
  await page.waitForTimeout(600)
  await openDatabaseNode(page)
  await page.waitForTimeout(400)

  await page.getByRole('treeitem', { name: /public/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename Schema…' }).click()
  const rn = page.getByRole('dialog', { name: 'Rename schema' })
  await expect(rn.getByText(/MSSQL cannot rename a schema/)).toBeVisible()
  await expect(rn.getByRole('button', { name: 'Confirm' })).toHaveCount(0)
  // the steps are still available to run by hand
  await rn.getByRole('button', { name: 'Open in SQL tab' }).click()
  await expect(page.getByRole('tab', { name: /Rename schema public/ }).first()).toBeVisible()

  await page.getByRole('treeitem', { name: /public/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Drop Schema…' }).click()
  const dp = page.getByRole('dialog', { name: 'Drop schema' })
  await expect(dp.getByText('DROP SCHEMA IF EXISTS [public];')).toBeVisible()
  await expect(dp.getByRole('checkbox')).toHaveCount(0) // T-SQL has no CASCADE
  await expect(dp.getByText(/only drops an EMPTY schema/)).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('schema node: New Schema creates one and the tree gains it', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await openPgTree(page)

  // reachable from the DATABASE node (a schema is created inside it)…
  await page.getByRole('treeitem', { name: /current/ }).first().click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'New Schema…' })).toBeVisible()
  await page.keyboard.press('Escape')
  // …and from a sibling schema
  await page.getByRole('treeitem', { name: /public/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New Schema…' }).click()

  const dialog = page.getByRole('dialog', { name: 'New schema' })
  await expect(dialog).toBeVisible()
  const name = dialog.locator('input#ns-name')
  await expect(name).toBeFocused()
  await expect(dialog.locator('input#ns-pwd')).toHaveCount(0) // password is Oracle-only
  // empty name → nothing to create
  await expect(dialog.getByRole('button', { name: 'Create' })).toHaveAttribute('aria-disabled', 'true')

  // a name already in use is refused before running anything
  await name.fill('public')
  await expect(dialog.getByText(/already exists here/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Create' })).toHaveAttribute('aria-disabled', 'true')

  await name.fill('staging')
  await expect(dialog.getByText('CREATE SCHEMA IF NOT EXISTS "staging";')).toBeVisible()
  // backdrop click must not close a form popup
  await page.mouse.click(8, 8)
  await expect(dialog).toBeVisible()

  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden({ timeout: 10_000 })
  const sql = await page.evaluate(() => (window as unknown as { __ipcLastSql?: string }).__ipcLastSql)
  // the splitter runs each statement without its trailing semicolon
  expect(sql).toBe('CREATE SCHEMA IF NOT EXISTS "staging"')
  await expect(page.getByRole('treeitem', { name: /staging/ }).first()).toBeVisible({ timeout: 10_000 })

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('Oracle: New Schema creates a user (password required, three statements)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.locator('.conn-row').filter({ hasText: '10.0.7.1' }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.waitForTimeout(400)

  await page.getByRole('treeitem', { name: /public/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New Schema…' }).click()
  const dialog = page.getByRole('dialog', { name: 'New schema' })
  await expect(dialog.getByText(/a schema IS a user/)).toBeVisible()
  await dialog.locator('input#ns-name').fill('APP_STAGING')
  // a name alone is not enough here — the user needs a password
  await expect(dialog.getByRole('button', { name: 'Create' })).toHaveAttribute('aria-disabled', 'true')
  await dialog.locator('input#ns-pwd').fill('S3cret')
  await expect(dialog.getByRole('button', { name: 'Create' })).toHaveAttribute('aria-disabled', 'false')
  // the preview is the whole set: user + grants + quota
  await expect(dialog.getByText(/CREATE USER "APP_STAGING" IDENTIFIED BY "S3cret";/)).toBeVisible()
  await expect(dialog.getByText(/GRANT CONNECT, RESOURCE TO "APP_STAGING";/)).toBeVisible()
  await expect(dialog.getByText(/ALTER USER "APP_STAGING" QUOTA UNLIMITED ON USERS;/)).toBeVisible()

  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden({ timeout: 10_000 })
  // every statement ran, in order — the last one is the quota
  const sql = await page.evaluate(() => (window as unknown as { __ipcLastSql?: string }).__ipcLastSql)
  expect(sql).toBe('ALTER USER "APP_STAGING" QUOTA UNLIMITED ON USERS')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
