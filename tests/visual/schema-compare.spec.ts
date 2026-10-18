import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, previewText } from './helpers'

// The connection/database pickers are searchable comboboxes (SearchSelect): click
// to open, then pick the option by its exact label.
async function pick(page: Page, title: string, label: string) {
  await page.getByTitle(title, { exact: true }).click()
  await page.waitForTimeout(150)
  await page.getByRole('option', { name: label, exact: true }).first().click()
  await page.waitForTimeout(150)
}

async function openCompare(page: Page, query = '') {
  await blockRemoteFonts(page)
  await page.goto(APP_URL + query)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.keyboard.press('Control+p')
  await page.waitForTimeout(150)
  await page.getByPlaceholder('Type a command or search…').fill('compare')
  await page.waitForTimeout(150)
  await page.getByText('Compare schemas…').first().click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('tab', { name: /Schema Compare/ }).first()).toBeVisible()
}

const card = (page: Page, label: string) => page.getByRole('button', { name: new RegExp(`^\\d+ ${label}$`) })
const row = (page: Page, name: string) => page.locator('.cmp-row').filter({ has: page.getByText(name, { exact: true }) })

test('schema compare: summary, object list, detail, script and apply', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  // compareDrift: Staging Postgres differs from Postgres; slowIntrospect makes the
  // read take long enough to see the progress screen.
  await openCompare(page, '?compareDrift=1&slowIntrospect=120')

  // empty state explains what the screen does
  await expect(page.getByText('Compare two database structures')).toBeVisible()
  // three-step guide before anything is picked
  await expect(page.getByText(/the database that is already right/)).toBeVisible()
  await expect(page.getByText(/the database you want to bring in line/)).toBeVisible()
  // the connection picker is searchable — typing filters the option list
  await page.getByTitle('Source connection', { exact: true }).click()
  await page.getByTitle('Source connection', { exact: true }).fill('mysql')
  await page.waitForTimeout(150)
  await expect(page.getByRole('option', { name: 'MySQL (mysql)', exact: true })).toBeVisible()
  await expect(page.getByRole('option', { name: 'Postgres (postgres)', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await pick(page, 'Source connection', 'Postgres (postgres)')
  await pick(page, 'Target connection', 'Staging Postgres (postgres)')

  // reading both sides shows progress instead of a frozen screen
  await expect(page.getByText('Reading both schemas…')).toBeVisible()
  await expect(page.getByText('Reading both schemas…')).toHaveCount(0, { timeout: 20_000 })

  // summary cards, worded as what happens to the target
  await expect(card(page, 'New')).toBeVisible()
  await expect(card(page, 'Changed')).toBeVisible()
  await expect(card(page, 'Extra')).toBeVisible()
  await expect(card(page, 'Same')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply to target' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Open script' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Refresh', exact: true }).and(page.getByTitle('Read both schemas again'))).toBeVisible()
  // the screen explains itself: roles of the two sides + what each status means
  await expect(page.getByText('— the reference: what it should look like')).toBeVisible()
  await expect(page.getByText('— the database that will be changed to match')).toBeVisible()
  await expect(page.getByText('in source only · will be created')).toBeVisible()
  await expect(page.getByText('in target only · will be dropped')).toBeVisible()
  await expect(page.getByText('nothing changes until you click Apply')).toBeVisible()

  // the default list shows only differences, each with a plain status
  await expect(row(page, 'schedule').locator('.sc-pill')).toHaveText('New')
  await expect(row(page, 'audit_log').locator('.sc-pill')).toHaveText('Extra')
  await expect(row(page, 'students').locator('.sc-pill')).toHaveText('Changed')
  await expect(row(page, 'students').getByText(/1 new column · 1 column changed · 1 extra column · 1 index to sync/)).toBeVisible()
  // an identical object is not listed by default
  await expect(row(page, 'vw_active_students')).toHaveCount(0)

  // detail: column-by-column comparison + its own script
  await row(page, 'students').click()
  await expect(page.locator('.cmp-row.sel')).toHaveCount(1)
  const detail = page.getByRole('region', { name: 'Details' })
  await expect(detail.getByText('Differs between source and target — the target will be altered.')).toBeVisible()
  const statusRow = detail.locator('tr').filter({ has: page.getByText('status', { exact: true }) })
  await expect(statusRow.getByText('varchar(20)')).toBeVisible()
  await expect(statusRow.getByText('varchar(10)')).toBeVisible()
  await expect(detail.locator('tr').filter({ has: page.getByText('legacy_code', { exact: true }) }).locator('.sc-pill')).toHaveText('Extra')
  await expect(detail.locator('tr').filter({ has: page.getByText('idx_students_gpa', { exact: true }) }).locator('.sc-pill')).toHaveText('New')
  const objScript = await previewText(page, 'Object script')
  expect(objScript).toContain('ADD COLUMN "is_active" bool')
  expect(objScript).toContain('ALTER COLUMN "status" TYPE varchar(20)')
  expect(objScript).toContain('DROP COLUMN "legacy_code"')

  // unchecking a column change removes it from what will run
  const before = await page.getByText(/statements? from \d+ selected/).textContent()
  await detail.locator('tr').filter({ has: page.getByText('legacy_code', { exact: true }) }).getByRole('checkbox').uncheck()
  await expect(page.getByText(/statements? from \d+ selected/)).not.toHaveText(before ?? '')

  // a changed function shows both definitions; Next/Prev walk the list
  await row(page, 'add_one').click()
  await expect(detail.getByText('Target · Staging Postgres')).toBeVisible()
  await expect(detail.getByText(/SELECT x \+ 2/)).toBeVisible()
  await expect(detail.getByText(/SELECT x \+ 1/)).toBeVisible()
  await detail.getByRole('button', { name: 'Previous object' }).click()
  await expect(page.locator('.cmp-row.sel')).toHaveCount(1)
  await expect(row(page, 'add_one')).not.toHaveClass(/sel/)

  // cards filter the list; search narrows it further
  await card(page, 'Extra').click()
  await expect(row(page, 'audit_log')).toBeVisible()
  await expect(row(page, 'schedule')).toHaveCount(0)
  await card(page, 'Extra').click()
  await page.getByLabel('Filter objects').fill('sched')
  await expect(row(page, 'schedule')).toBeVisible()
  await expect(row(page, 'students')).toHaveCount(0)
  await page.getByLabel('Filter objects').fill('')

  // the whole script
  await page.getByRole('button', { name: 'Sync script' }).click()
  const script = await previewText(page, 'Migration script')
  expect(script).toContain('Migration: sync TARGET')
  expect(script).toContain('CREATE TABLE "schedule"')
  expect(script).toContain('DROP TABLE "audit_log";')

  // Apply: in-app confirm naming the target + the data-loss warning
  await page.getByRole('button', { name: 'Apply to target' }).click()
  const dialog = page.getByRole('dialog', { name: 'Apply changes to the target' })
  await expect(dialog.getByText(/to Staging Postgres/)).toBeVisible()
  await expect(dialog.getByText(/drops? a table or column/)).toBeVisible()
  await page.mouse.click(8, 8) // backdrop does not dismiss a form dialog
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 10_000 })
  await expect(page.getByText(/Applied \d+ of \d+ statement/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('schema compare: identical schemas say so, and every object can still be browsed', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openCompare(page)
  await pick(page, 'Source connection', 'Postgres (postgres)')
  await pick(page, 'Target connection', 'Staging Postgres (postgres)')

  await expect(page.getByText('✓ The structures are identical')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: 'Apply to target' })).toBeDisabled()
  await expect(page.getByText(/Nothing to sync/)).toBeVisible()

  await page.getByText('Show identical').first().click()
  await expect(page.getByText('Tables', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Functions', { exact: true }).first()).toBeVisible()
  await expect(page.getByTitle('Select all Tables')).toBeVisible()
  await row(page, 'students').click()
  const detail = page.getByRole('region', { name: 'Details' })
  await expect(detail.getByText('Identical in both — nothing to do.')).toBeVisible()
  await expect(detail.getByText(/All \d+ columns are the same/)).toBeVisible()
  await detail.getByText(/Show \d+ unchanged/).click()
  await expect(detail.getByText('first_name', { exact: true })).toBeVisible()
  await expect(detail.getByText('Nothing to run — this object already matches.')).toBeVisible()

  // keyboard: ↓ moves the selection to the next object
  await page.getByRole('listbox', { name: 'Compared objects' }).focus()
  await page.keyboard.press('ArrowDown')
  await expect(row(page, 'students')).not.toHaveClass(/sel/)
  await expect(page.locator('.cmp-row.sel')).toHaveCount(1)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Compare two databases within the SAME connection (DB dropdowns appear once a
// connection is chosen; sub-connections are attached per database).
test('schema compare: two databases in one connection', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openCompare(page)

  await pick(page, 'Source connection', 'Postgres (postgres)')
  await page.waitForTimeout(300)
  await pick(page, 'Source database', 'analytics')
  await pick(page, 'Target connection', 'Postgres (postgres)')
  await page.waitForTimeout(300)
  await pick(page, 'Target database', 'postgres')
  await page.waitForTimeout(500)

  // different databases of the same connection compare without the "same database" warning
  await expect(page.getByText(/Source and target are the same database/)).toHaveCount(0)
  await expect(card(page, 'New')).toBeVisible({ timeout: 10_000 })
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
