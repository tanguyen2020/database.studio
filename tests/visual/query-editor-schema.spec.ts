import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// The Query Editor shows a Schema dropdown next to the Database dropdown ONLY for
// schema-based systems (Postgres/MSSQL — a database split into schemas). Systems
// where a "database" already IS the schema (MySQL/MariaDB/ClickHouse) don't show it.

async function newTabFor(page: import('@playwright/test').Page, hostText: string) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByText(hostText, { exact: false }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('New Query Console', { exact: true }).first().click()
  await page.waitForTimeout(700)
}

test('Postgres query editor shows a Schema dropdown', async ({ page }) => {
  await newTabFor(page, '10.0.1.5') // Postgres connection (unique host)
  const schema = page.getByTitle('Schema', { exact: true })
  await expect(schema).toBeVisible()
  await expect(schema).toHaveValue('public') // defaults to the DB's default schema
  // the Database dropdown is still there alongside it
  await expect(page.getByTitle('Database', { exact: true })).toBeVisible()
})

test('MySQL query editor has no Schema dropdown (database IS the schema)', async ({ page }) => {
  await newTabFor(page, 'localhost:3306') // MySQL connection
  await expect(page.getByTitle('Database', { exact: true })).toBeVisible()
  await expect(page.getByTitle('Schema', { exact: true })).toHaveCount(0)
})
