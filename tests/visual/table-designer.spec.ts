import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

test('table designer: columns grid + DDL preview + add column', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // select a Postgres connection so Explorer loads, then "New table" bottom button
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByTitle('New table').first().click()
  await page.waitForTimeout(300)

  // designer tab open with columns grid (seeded id PK row)
  await expect(page.getByRole('tab', { name: /new_table · design/ }).first()).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Column' }).first()).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Nullable' }).first()).toBeVisible()

  // add a column
  await page.getByText('＋ Add column').first().click()
  await page.waitForTimeout(150)

  // Scripts mode → DDL preview shows CREATE TABLE
  await page.getByText('Scripts', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/CREATE TABLE/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('table designer: attribute tabs + index in DDL + Ctrl+S saves', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByTitle('New table').first().click()
  await page.waitForTimeout(300)

  // all six attribute tabs are present
  for (const t of ['Fields', 'Indexes', 'Foreign Keys', 'Uniques', 'Checks', 'Triggers']) {
    await expect(page.getByRole('tab', { name: new RegExp(t) }).first()).toBeVisible()
  }

  // Indexes tab → add an index and give it a name + column
  await page.getByRole('tab', { name: /Indexes/ }).first().click()
  await page.getByText('＋ Add index').first().click()
  await page.waitForTimeout(100)
  const idxRow = page.locator('tbody tr').first()
  await idxRow.locator('input').nth(0).fill('ix_email')
  await idxRow.locator('input').nth(1).fill('email')
  await page.waitForTimeout(100)

  // Foreign Keys tab exists and can add a row
  await page.getByRole('tab', { name: /Foreign Keys/ }).first().click()
  await expect(page.getByText('＋ Add foreign key').first()).toBeVisible()

  // Scripts preview includes the CREATE INDEX we defined
  await page.getByText('Scripts', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/CREATE INDEX "ix_email"/).first()).toBeVisible()

  // Ctrl+S runs the DDL (demo exec returns ok → success toast)
  await page.keyboard.press('Control+s')
  await expect(page.getByText(/Applied/).first()).toBeVisible({ timeout: 5000 })

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Task 4: designing an EXISTING table lets you drop objects across tabs — the ×
// on an existing column marks it dropped (strikethrough) and the Scripts preview
// emits an ALTER … DROP COLUMN.
test('table designer: existing table can drop a column (ALTER DROP COLUMN)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  await page.getByRole('treeitem', { name: /students/ }).first().click({ button: 'right' })
  await page.waitForTimeout(150)
  await page.getByText('Design Table', { exact: true }).first().click()
  await page.waitForTimeout(400)

  // Fields tab shows the existing columns (seeded). Drop one via its × (→ ↺).
  const dropBtn = page.locator('[title="Drop column"]').first()
  await expect(dropBtn).toBeVisible()
  await dropBtn.click()
  await page.waitForTimeout(150)
  await expect(page.locator('[title="Restore column"]').first()).toBeVisible()

  // Scripts preview now contains an ALTER … DROP COLUMN
  await page.getByText('Scripts', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/DROP COLUMN/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
