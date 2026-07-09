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

  // item 3/8 — the DataType cell is a searchable dropdown listing the engine's
  // full type catalog. Focus it → options appear; type to filter → pick one.
  const typeInput = page.locator('table input[placeholder="type…"]').first()
  await typeInput.click()
  await page.waitForTimeout(150)
  await expect(page.getByRole('option').first()).toBeVisible()
  // keyboard selection: filter to 'big' then Enter picks the highlighted option (bigint)
  await typeInput.fill('big')
  await page.waitForTimeout(150)
  await typeInput.press('Enter')
  await page.waitForTimeout(100)
  await expect(typeInput).toHaveValue('bigint')
  // reopens a second time (click-twice bug fixed) — Postgres catalog includes jsonb
  await typeInput.click()
  await page.waitForTimeout(150)
  await expect(page.getByRole('option').first()).toBeVisible()
  await typeInput.fill('jsonb')
  await page.waitForTimeout(150)
  await page.getByRole('option', { name: 'jsonb', exact: true }).first().click()
  await page.waitForTimeout(100)
  await expect(typeInput).toHaveValue('jsonb')

  // Scripts mode → DDL preview shows CREATE TABLE with the picked type
  await page.getByText('Scripts', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/CREATE TABLE/).first()).toBeVisible()
  await expect(page.getByText(/jsonb/).first()).toBeVisible()

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

  // Fields tab → add an 'email' column so it can be picked in the index
  await page.getByRole('tab', { name: /Fields/ }).first().click()
  await page.getByText('＋ Add column').first().click()
  await page.waitForTimeout(100)
  await page.locator('tbody tr').last().locator('input').first().fill('email')
  await page.waitForTimeout(100)

  // Indexes tab → add an index, name it, and pick the 'email' column from the dropdown
  await page.getByRole('tab', { name: /Indexes/ }).first().click()
  await page.getByText('＋ Add index').first().click()
  await page.waitForTimeout(100)
  const idxRow = page.locator('tbody tr').first()
  await idxRow.locator('input').nth(0).fill('ix_email') // index name
  const colInput = idxRow.locator('input').nth(1)
  await colInput.click() // open the Columns multi-select
  await page.waitForTimeout(150)
  // keyboard selection: filter to the single 'email' match, then Enter picks it
  await colInput.fill('email')
  await page.waitForTimeout(150)
  await colInput.press('Enter')
  await page.waitForTimeout(100)
  // the picked column shows as a chip (label + × remove button) in the row
  await expect(idxRow.getByText('email').first()).toBeVisible()

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

// Fields grid convenience: a "#" column, ArrowDown/Tab off a filled last row opens
// a fresh row for entry (never a second empty one), and rows drag-reorder.
test('table designer: # column, ArrowDown auto-appends a field row, drag reorders', async ({ page }) => {
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

  // the "#" reorder column is present
  await expect(page.getByRole('columnheader', { name: '#', exact: true }).first()).toBeVisible()

  const rows = page.locator('tbody tr')
  await expect(rows).toHaveCount(1) // seeded id PK row (has data)

  // ArrowDown from the filled row appends a new empty row and focuses it
  await rows.nth(0).locator('input').first().click() // id name input
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(150)
  await expect(rows).toHaveCount(2)

  // ArrowDown on the still-empty last row must NOT open a second empty row
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(150)
  await expect(rows).toHaveCount(2)

  // once the row has data, ArrowDown appends again
  await page.keyboard.type('email')
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(150)
  await expect(rows).toHaveCount(3)

  // drag reorders: drag the 'email' row (#2) onto the id row (#1) → email first
  await rows.nth(1).locator('td').first().dragTo(rows.nth(0).locator('td').first())
  await page.waitForTimeout(150)
  await expect(rows.nth(0).locator('input').first()).toHaveValue('email')

  // the ▲/▼ buttons reorder too (reliable in the WebView): move email back down
  await rows.nth(0).getByTitle('Move down').click()
  await page.waitForTimeout(150)
  await expect(rows.nth(0).locator('input').first()).toHaveValue('id')
  await expect(rows.nth(1).locator('input').first()).toHaveValue('email')

  // the row order flows into the DDL
  await page.getByText('Scripts', { exact: true }).first().click()
  await page.waitForTimeout(200)
  const ddl = await page.getByText(/CREATE TABLE/).first().innerText()
  expect(ddl.indexOf('"id"')).toBeLessThan(ddl.indexOf('"email"'))

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

test('table designer: Partitioning tab emits PARTITION BY in the DDL preview', async ({ page }) => {
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

  // open the Partitioning tab (free-text key column drives the clause)
  await page.getByRole('tab', { name: 'Partitioning' }).click()
  await page.waitForTimeout(150)
  await page.getByText('Partition this table').click()
  await page.waitForTimeout(150)
  await page.getByPlaceholder('created_at').fill('created_at')
  await page.waitForTimeout(150)

  // preview reflects the partition clause
  await page.getByText('Scripts', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.locator('pre').first()).toContainText('PARTITION BY RANGE ("created_at")')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('table designer: Design existing partitioned table shows partitions + can add one', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)

  // Design the demo's partitioned table (enrollments)
  await page.getByRole('treeitem', { name: /enrollments/ }).first().click({ button: 'right' })
  await page.waitForTimeout(150)
  await page.getByText('Design Table', { exact: true }).first().click()
  await page.waitForTimeout(400)

  await page.getByRole('tab', { name: 'Partitioning' }).click()
  await page.waitForTimeout(200)

  // existing partitioning is shown read-only (existing partition rows are disabled)
  await expect(page.getByText(/Current partitioning/).first()).toBeVisible()
  await expect(page.locator('table input[disabled]').first()).toHaveValue('enrollments_2023')

  // add a new partition using the structured From / To inputs (PG composes the bound)
  await page.getByText('＋ Add partition').first().click()
  await page.waitForTimeout(150)
  await page.getByPlaceholder(/enrollments_p/).last().fill('enrollments_2026')
  await page.getByPlaceholder("'2024-01-01'").last().fill("'2026-01-01'")
  await page.getByPlaceholder("'2025-01-01'").last().fill("'2027-01-01'")
  await page.waitForTimeout(200)

  // the inline partition-script preview updates live (no need to switch tabs)
  await expect(page.getByText('Add-partition script').first()).toBeVisible()
  await expect(page.locator('pre').first()).toContainText(
    `PARTITION OF "public"."enrollments" FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')`,
  )

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('table designer: convert an existing non-partitioned table to partitioned', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)

  // Design the non-partitioned demo table (students)
  await page.getByRole('treeitem', { name: /students/ }).first().click({ button: 'right' })
  await page.waitForTimeout(150)
  await page.getByText('Design Table', { exact: true }).first().click()
  await page.waitForTimeout(400)

  await page.getByRole('tab', { name: 'Partitioning' }).click()
  await page.waitForTimeout(200)

  // the toggle is enabled (PG can convert) — turn it on
  await page.getByText('Partition this table').click()
  await page.waitForTimeout(200)

  // fill the key + one partition (From / To)
  await page.getByPlaceholder('created_at').fill('created_at')
  await page.getByPlaceholder(/students_p/).first().fill('students_2024')
  await page.getByPlaceholder("'2024-01-01'").first().fill("'2024-01-01'")
  await page.getByPlaceholder("'2025-01-01'").first().fill("'2025-01-01'")
  await page.waitForTimeout(200)

  // convert script preview shows the rename + recreate + PARTITION OF migration
  await expect(page.getByText('Convert-to-partitioned script').first()).toBeVisible()
  const pre = page.locator('pre').first()
  await expect(pre).toContainText('RENAME TO "students_old"')
  await expect(pre).toContainText('PARTITION OF "public"."students"')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
