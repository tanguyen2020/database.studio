import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode, previewText } from './helpers'

// Partitions node — expanding a partitioned table (demo: enrollments) shows a
// "Partitions" folder listing its partitions, with a right-click maintenance menu.
test('explorer: partitioned table shows a Partitions node with partitions', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)

  // public → Tables → enrollments (expand its detail)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  // Discoverability: the table's right-click menu exposes a Partitions submenu.
  await page.getByRole('treeitem', { name: /enrollments/ }).first().click({ button: 'right' })
  await page.waitForTimeout(150)
  await expect(page.getByText('Partitions', { exact: true }).first()).toBeVisible()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(100)

  await page.getByRole('treeitem', { name: /enrollments/ }).first().getByRole('button').first().click()
  await page.waitForTimeout(400)

  // Partitions folder appears (enrollments is the demo's partitioned table)
  const partsFolder = page.getByRole('treeitem', { name: /Partitions/ }).first()
  await expect(partsFolder).toBeVisible()

  // Expand it via its chevron → a partition row shows
  await partsFolder.getByRole('button').first().click()
  await page.waitForTimeout(300)
  const part = page.getByRole('treeitem', { name: /enrollments_2024/ }).first()
  await part.scrollIntoViewIfNeeded()
  await expect(part).toBeVisible()

  // Right-click a partition → maintenance menu (Detach / Drop) for Postgres.
  // A PG partition is a real table but is no longer listed next to its parent,
  // so this menu must be able to open it — otherwise hiding it loses a way in.
  await part.click({ button: 'right' })
  await page.waitForTimeout(150)
  await expect(page.getByText('Detach partition').first()).toBeVisible()
  const openData = page.getByRole('menuitem', { name: 'Open Data' })
  await expect(openData).toBeVisible()
  await openData.click()
  await page.waitForTimeout(500)
  await expect(page.getByRole('tab', { name: /enrollments_2024/ }).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Add Partition dialog — the table menu's Partitions ▸ Add Partition… opens a
// structured dialog with a live script (not just a raw SQL template).
test('add partition dialog: structured form + live script', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)

  // right-click enrollments → Partitions ▸ → Add Partition…
  await page.getByRole('treeitem', { name: /enrollments/ }).first().click({ button: 'right' })
  await page.waitForTimeout(150)
  await page.getByRole('menuitem', { name: 'Partitions' }).hover()
  await page.waitForTimeout(200)
  await page.getByRole('menuitem', { name: 'Add Partition…' }).click()
  await page.waitForTimeout(300)

  // dialog opens with the table's current partitioning + structured RANGE inputs
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByText('Add Partition · public.enrollments')).toBeVisible()
  await page.getByPlaceholder('enrollments_pN').fill('enrollments_2027')
  await page.getByPlaceholder("'2026-01-01'").fill("'2027-01-01'")
  await page.getByPlaceholder("'2027-01-01'").fill("'2028-01-01'")
  await page.waitForTimeout(200)

  // live script updates inside the dialog
  expect(await previewText(page, 'Partition script')).toContain(
    `PARTITION OF "public"."enrollments" FOR VALUES FROM ('2027-01-01') TO ('2028-01-01')`,
  )

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Oracle: the builder emits runnable ALTER TABLE … ADD PARTITION, so the dialog
// must offer "Add partition" — not just the SQL-tab escape hatch (MSSQL/ClickHouse
// only warn, so they keep the template-only flow).
test('add partition dialog: Oracle can run it, with Oracle grammar', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByText('10.0.7.1', { exact: false }).first().click() // the Oracle connection
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)

  await page.getByRole('treeitem', { name: /enrollments/ }).first().click({ button: 'right' })
  await page.waitForTimeout(150)
  await page.getByRole('menuitem', { name: 'Partitions' }).hover()
  await page.waitForTimeout(200)
  await page.getByRole('menuitem', { name: 'Add Partition…' }).click()
  await page.waitForTimeout(300)

  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByPlaceholder('enrollments_pN').fill('P2027')
  await page.getByPlaceholder('2027').fill("DATE '2028-01-01'")
  await page.waitForTimeout(200)

  // Oracle grammar: ADD PARTITION <name> VALUES LESS THAN (…), double-quoted idents
  expect(await previewText(page, 'Partition script')).toContain(
    `ALTER TABLE "public"."enrollments" ADD PARTITION "P2027" VALUES LESS THAN (DATE '2028-01-01');`,
  )
  await expect(page.getByRole('button', { name: 'Add partition' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open in SQL tab' })).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Hiding partitions is a DISPLAY rule, not a data rule. The table list still
// carries them, so everything else that reads it keeps working — this test pins
// both halves at once, because dropping them at the source silently broke
// autocomplete, Generate Scripts and Schema Compare.
test('partitions are hidden in the tree but still available to the rest of the app', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(400)

  // (1) the tree shows the parent, not the partition
  await expect(page.getByTitle('enrollments', { exact: true }).first()).toBeVisible()
  await expect(page.getByTitle('enrollments_2024', { exact: true })).toHaveCount(0)

  // (2) …but the data is still there: the Query Editor suggests it
  await page.getByTitle('enrollments', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(150)
  await page.getByRole('menuitem', { name: 'New Query' }).first().click()
  await page.waitForTimeout(600)
  const editor = page.locator('.view-lines').first()
  await editor.click()
  await page.keyboard.type('select * from enrollments_2')
  await page.waitForTimeout(700)
  const suggest = page.locator('.suggest-widget.visible')
  await expect(suggest).toBeVisible()
  await expect(suggest.getByText('enrollments_2024').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// A partitioned table is recognisable BEFORE it is expanded (the "P" badge on its
// icon), and each partition opens like a table: the same columns / indexes /
// constraints, just nested under the parent's Partitions node.
test('explorer: a partitioned table is badged, and its partitions open like tables', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)

  // (1) only the partitioned table carries the badge — a plain table keeps the
  //     plain grid glyph, so the badge actually distinguishes something.
  const badge = (name: string) =>
    page.getByTitle(name, { exact: true }).first().locator('svg[data-badge="partitioned"]')
  await expect(badge('enrollments')).toHaveCount(1)
  await expect(badge('enrollments')).toHaveAttribute('aria-label', 'Partitioned table')
  await expect(badge('students')).toHaveCount(0)

  // (2) a partition expands into its own columns / indexes / constraints
  const chevron = (name: string) => page.getByTitle(name, { exact: true }).first().locator('span').first()
  await chevron('enrollments').click()
  await page.waitForTimeout(400)
  await chevron('Partitions').click()
  await page.waitForTimeout(300)

  const part = page.getByTitle('enrollments_2023', { exact: true }).first()
  await expect(part).toBeVisible()
  await expect(part).toHaveAttribute('aria-expanded', 'false')
  await chevron('enrollments_2023').click()
  await page.waitForTimeout(500)
  await expect(part).toHaveAttribute('aria-expanded', 'true')

  // its children are the table shape: Columns / Indexes / Constraints folders.
  // Scope to the rows BELOW the partition so the parent's own children cannot
  // satisfy the assertions.
  const rows = page.locator('[role="treeitem"]')
  const all = await rows.allInnerTexts()
  const at = all.findIndex((t) => t.includes('enrollments_2023'))
  expect(at).toBeGreaterThan(-1)
  const under = all.slice(at + 1, at + 4).join(" | ")
  expect(under).toContain('Columns')
  expect(under).toContain('Indexes')
  expect(under).toContain('Constraints')

  // and the partition's OWN columns are in there — the same shape a table has
  const partCols = page.getByRole('treeitem', { name: /Columns/ }).last()
  await partCols.getByRole('button').first().click()
  await page.waitForTimeout(400)
  const after = await rows.allInnerTexts()
  const atCols = after.findIndex((t) => t.includes('enrollments_2023'))
  expect(after.slice(atCols + 1, atCols + 8).join(" | ")).toContain('enrolled_on')

  expect(errors, `page errors: ${errors.join("\n")}`).toEqual([])
})
