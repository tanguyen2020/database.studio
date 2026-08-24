import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// The Query Editor shows a Schema dropdown next to the Database dropdown ONLY for
// schema-based systems (Postgres/MSSQL — a database split into schemas). Systems
// where a "database" already IS the schema (MySQL/MariaDB/ClickHouse) don't show it.

/** Both dropdowns are searchable comboboxes (an input + an option list). */
async function pick(input: import('@playwright/test').Locator, value: string) {
  const page = input.page()
  await input.click()
  await page.waitForTimeout(200)
  await input.fill(value)
  await page.waitForTimeout(200)
  await page.getByRole('option', { name: value, exact: true }).first().click()
  await page.waitForTimeout(300)
}

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
  const schema = page.locator('input[title="Schema"]:visible')
  await expect(schema).toBeVisible()
  await expect(schema).toHaveValue('public') // defaults to the DB's default schema
  // the Database dropdown is still there alongside it
  await expect(page.locator('input[title="Database"]:visible')).toBeVisible()
})

// Picking a schema must repoint autocomplete at THAT schema's tables — including
// when switching back to a schema whose tables are already cached (nothing in the
// cache changes then, so only the pick itself signals the editor to rebuild).
test('switching schema repoints unqualified table suggestions', async ({ page }) => {
  await newTabFor(page, '10.0.1.5') // Postgres
  // move to a database that has a second schema
  const dbInput = page.locator('input[title="Database"]:visible')
  await dbInput.click()
  await dbInput.fill('analy')
  await page.getByRole('option', { name: 'analytics' }).first().click()
  await page.waitForTimeout(900)

  const schema = page.locator('input[title="Schema"]:visible')
  const type = async (text: string) => {
    await page.locator('.view-lines').first().click()
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Delete')
    await page.keyboard.type(text)
    await page.waitForTimeout(600)
    const tip = page.locator('.suggest-widget.visible')
    await expect(tip).toBeVisible({ timeout: 4000 })
    return tip.innerText()
  }

  await pick(schema, 'reporting')
  await page.waitForTimeout(900)
  expect(await type('SELECT * FROM report_')).toContain('report_daily')

  // back to public — its tables are already cached, so the rebuild has to be
  // driven by the pick, not by cache movement
  await pick(schema, 'public')
  await page.waitForTimeout(700)
  expect(await type('SELECT * FROM stu')).toContain('students')
})

test('MySQL query editor has no Schema dropdown (database IS the schema)', async ({ page }) => {
  await newTabFor(page, 'localhost:3306') // MySQL connection
  await expect(page.locator('input[title="Database"]:visible')).toBeVisible()
  await expect(page.locator('input[title="Schema"]:visible')).toHaveCount(0)
})
