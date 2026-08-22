import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// User request — the New Database dialog must offer the character set / collation
// that the engine really supports, read from the server (never a hard-coded list),
// while leaving the previous behaviour intact: with everything on "Server default"
// the statement stays the plain `CREATE DATABASE <name>;`.
//
// Fields are located by the input's title (which names the clause it feeds) because
// the visible label text also picks up the combobox caret.

async function openNewDatabase(page: import('@playwright/test').Page, connection: string | RegExp) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  // right-click the connection ROW (host:port is unique per demo connection; the
  // system group header would match a bare name like /MySQL/)
  await page.getByText(connection, { exact: false }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('New Database…', { exact: true }).first().click()
  await page.waitForTimeout(500)
  const dialog = page.getByRole('dialog', { name: 'New Database' })
  await expect(dialog).toBeVisible()
  return { dialog, errors }
}

const field = (dialog: import('@playwright/test').Locator, titlePart: string) =>
  dialog.locator(`input[title*="${titlePart}"]`).first()

/** Pick an option in a SearchSelect by clicking its input then the option row. */
async function pick(dialog: import('@playwright/test').Locator, titlePart: string, option: string) {
  const input = field(dialog, titlePart)
  await input.click()
  await input.page().waitForTimeout(200)
  await input.page().getByRole('option', { name: option, exact: true }).first().click()
  await input.page().waitForTimeout(200)
}

test('MySQL: character set + collation come from the server and land in the DDL', async ({ page }) => {
  const { dialog, errors } = await openNewDatabase(page, 'localhost:3306')

  // both fields, defaulted to the server's own character_set_server/collation_server
  await expect(field(dialog, 'CHARACTER SET')).toBeVisible()
  await expect(field(dialog, 'COLLATE')).toBeVisible()
  await expect(dialog.getByPlaceholder('Server default (utf8mb4)')).toBeVisible()
  await expect(dialog.getByPlaceholder('Server default (utf8mb4_0900_ai_ci)')).toBeVisible()

  // unchanged default behaviour: nothing picked → plain statement
  await dialog.getByPlaceholder('new_database').fill('shopdb')
  await page.waitForTimeout(150)
  await expect(dialog).toContainText('CREATE DATABASE `shopdb`;')

  // charset list is the server's (utf8mb4 / latin1 from information_schema)
  await pick(dialog, 'CHARACTER SET', 'utf8mb4')
  await pick(dialog, 'COLLATE', 'utf8mb4_general_ci')
  await expect(dialog).toContainText('CREATE DATABASE `shopdb` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('MySQL: changing the character set drops a collation that no longer fits', async ({ page }) => {
  const { dialog, errors } = await openNewDatabase(page, 'localhost:3306')
  await dialog.getByPlaceholder('new_database').fill('shopdb')
  await pick(dialog, 'CHARACTER SET', 'utf8mb4')
  await pick(dialog, 'COLLATE', 'utf8mb4_unicode_ci')
  await expect(dialog).toContainText('COLLATE utf8mb4_unicode_ci')

  // latin1 has no utf8mb4_* collation → the stale pick is cleared, not sent
  await pick(dialog, 'CHARACTER SET', 'latin1')
  await expect(dialog).toContainText('CREATE DATABASE `shopdb` CHARACTER SET latin1;')
  await expect(dialog).not.toContainText('utf8mb4_unicode_ci')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('PostgreSQL: encoding + locale add TEMPLATE template0 to the statement', async ({ page }) => {
  const { dialog, errors } = await openNewDatabase(page, '10.0.1.5:5432')

  await expect(field(dialog, 'ENCODING')).toBeVisible()
  await expect(field(dialog, 'LC_COLLATE')).toBeVisible()
  await expect(field(dialog, 'LC_CTYPE')).toBeVisible()
  // defaults read from template1 — what a bare CREATE DATABASE copies
  await expect(dialog.getByPlaceholder('Server default (UTF8)')).toBeVisible()

  await dialog.getByPlaceholder('new_database').fill('shopdb')
  await page.waitForTimeout(150)
  await expect(dialog).toContainText('CREATE DATABASE "shopdb";')

  await pick(dialog, 'ENCODING', 'LATIN1')
  await expect(dialog).toContainText('TEMPLATE template0')
  await expect(dialog).toContainText("ENCODING 'LATIN1'")

  // picking LC_COLLATE mirrors LC_CTYPE (the usual pairing) — both reach the DDL
  await pick(dialog, 'LC_COLLATE', 'C')
  await expect(dialog).toContainText("LC_COLLATE 'C'")
  await expect(dialog).toContainText("LC_CTYPE 'C'")

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('SQL Server: collation list comes from the instance', async ({ page }) => {
  const { dialog, errors } = await openNewDatabase(page, '10.0.2.9:1433')

  // no charset field on MSSQL — only COLLATE
  await expect(field(dialog, 'COLLATE')).toBeVisible()
  await expect(dialog.locator('input[title*="CHARACTER SET"]')).toHaveCount(0)
  await expect(dialog.getByPlaceholder('Server default (SQL_Latin1_General_CP1_CI_AS)')).toBeVisible()

  await dialog.getByPlaceholder('new_database').fill('shopdb')
  await page.waitForTimeout(150)
  await expect(dialog).toContainText('CREATE DATABASE [shopdb];')

  await pick(dialog, 'COLLATE', 'Vietnamese_CI_AS')
  await expect(dialog).toContainText('CREATE DATABASE [shopdb] COLLATE Vietnamese_CI_AS;')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('ClickHouse: says plainly there is no database-level collation', async ({ page }) => {
  const { dialog, errors } = await openNewDatabase(page, '10.0.4.2:8123')
  await expect(dialog.locator('input[title*="COLLATE"]')).toHaveCount(0)
  await expect(dialog.getByText(/no character set or collation at database level/)).toBeVisible()
  await dialog.getByPlaceholder('new_database').fill('shopdb')
  await page.waitForTimeout(150)
  await expect(dialog).toContainText('CREATE DATABASE `shopdb`;')
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
