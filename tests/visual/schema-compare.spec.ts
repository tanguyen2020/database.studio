import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

test('schema compare: pick source/target + diff view + sync script', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // open via Command Palette → Compare schemas…
  await page.keyboard.press('Control+p')
  await page.waitForTimeout(150)
  await page.getByPlaceholder('Type a command or search…').fill('compare')
  await page.waitForTimeout(150)
  await page.getByText('Compare schemas…').first().click()
  await page.waitForTimeout(300)

  await expect(page.getByRole('tab', { name: /Schema Compare/ }).first()).toBeVisible()
  // pick two same-system (postgres) connections (by title — DB dropdowns appear
  // between them once a connection is chosen, shifting positional indices)
  await page.getByTitle('Source connection').selectOption({ label: 'Postgres (postgres)' })
  await page.waitForTimeout(200)
  await page.getByTitle('Target connection').selectOption({ label: 'Staging Postgres (postgres)' })
  await page.waitForTimeout(500)

  // diff toolbar badges render (add/changed/delete counts)
  await expect(page.getByText(/add$/).first()).toBeVisible()
  await expect(page.getByText(/changed$/).first()).toBeVisible()

  // T19 — routine rows + side-by-side DDL diff panel (prev/next)
  await page.getByText('Show identical').first().click()
  await page.waitForTimeout(200)
  await page.getByText(/add_one/).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByRole('dialog').getByText(/Source ·/).first()).toBeVisible()
  await expect(page.getByText(/Next ▶/).first()).toBeVisible()
  await page.getByRole('dialog').getByText('×').first().click()
  await page.waitForTimeout(150)

  // Sync Script mode shows migration pre + an Execute button (task 5)
  await page.getByText('Sync Script', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/Migration: sync TARGET/).first()).toBeVisible()
  const execBtn = page.getByText('Execute', { exact: true }).first()
  await expect(execBtn).toBeVisible()
  // clicking Execute runs the migration on the target (demo exec ok → toast).
  page.once('dialog', (d) => d.accept())
  await execBtn.click()
  await page.waitForTimeout(400)
  await expect(page.getByText(/Executed|Nothing to execute/).first()).toBeVisible({ timeout: 5000 })

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Item 2 — a table row expands to show its per-column (name · datatype) diff.
test('schema compare: table row expands to column-level diff', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.keyboard.press('Control+p')
  await page.waitForTimeout(150)
  await page.getByPlaceholder('Type a command or search…').fill('compare')
  await page.waitForTimeout(150)
  await page.getByText('Compare schemas…').first().click()
  await page.waitForTimeout(300)
  await page.getByTitle('Source connection').selectOption({ label: 'Postgres (postgres)' })
  await page.waitForTimeout(200)
  await page.getByTitle('Target connection').selectOption({ label: 'Staging Postgres (postgres)' })
  await page.waitForTimeout(500)

  // show identical so the demo (same data both sides) lists tables, then expand one
  await page.getByText('Show identical').first().click()
  await page.waitForTimeout(200)
  await page.getByText('students', { exact: true }).first().click()
  await page.waitForTimeout(200)
  // its columns (from list_columns demo) appear in the expansion
  await expect(page.getByText('first_name').first()).toBeVisible()
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Item 6 — compare two databases within the SAME connection (DB dropdowns appear
// once a connection is chosen; sub-connections are attached per database).
test('schema compare: two databases in one connection', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.keyboard.press('Control+p')
  await page.waitForTimeout(150)
  await page.getByPlaceholder('Type a command or search…').fill('compare')
  await page.waitForTimeout(150)
  await page.getByText('Compare schemas…').first().click()
  await page.waitForTimeout(300)

  await page.getByTitle('Source connection').selectOption({ label: 'Postgres (postgres)' })
  await page.waitForTimeout(300)
  // a Source database dropdown appears — pick a database
  await page.getByTitle('Source database').selectOption('analytics')
  await page.waitForTimeout(200)
  await page.getByTitle('Target connection').selectOption({ label: 'Postgres (postgres)' })
  await page.waitForTimeout(300)
  await page.getByTitle('Target database').selectOption('postgres')
  await page.waitForTimeout(500)

  // different databases of the same connection compare without the "same database" warning
  await expect(page.getByText(/Source and target are the same database/)).toHaveCount(0)
  await expect(page.getByText(/add$/).first()).toBeVisible()
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
