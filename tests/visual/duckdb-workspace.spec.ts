import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode, previewText } from './helpers'

// DuckDB workspace — Overview · Databases · Extensions · Settings, Import file,
// Export (COPY TO), Attach database and the data Profile. The statements these
// screens build are run on the real engine by duckdb_integration.rs
// (duckdb_workspace_statements_run); this spec checks the screens drive them.
// Demo answers: src/lib/duckdb/demo-workspace.ts (opt-in `?duckdb=1`).

async function open(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  const url = new URL(APP_URL)
  url.searchParams.set('duckdb', '1')
  await page.goto(url.toString())
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  return errors
}

const conn = (page: Page) => page.getByRole('button', { name: /Warehouse DuckDB/ })
const sqlLog = (page: Page) => page.evaluate(() => (window as unknown as { __ipcSqlLog?: string[] }).__ipcSqlLog ?? [])

async function openHome(page: Page, item = 'DuckDB Overview') {
  await conn(page).click()
  await conn(page).click({ button: 'right' })
  await page.getByRole('menuitem', { name: item }).click()
  await expect(page.getByTestId('duckdb-home')).toBeVisible()
}

test('duckdb workspace: the official logo, overview stats, databases + detach', async ({ page }) => {
  const errors = await open(page)
  // the sidebar icon is the official DuckDB mark (yellow disc + black duck)
  const logo = page.locator('aside svg[data-logo="duckdb"]').first()
  await expect(logo).toBeVisible()
  await expect(logo.locator('path')).toHaveCount(3)

  await openHome(page)
  const home = page.getByTestId('duckdb-home')
  await expect(home.getByText('DuckDB v1.5.6 · windows_amd64')).toBeVisible()
  const stats = page.getByTestId('duckdb-stats')
  await expect(stats).toContainText('48.5 MiB')
  await expect(stats).toContainText('WAL 1.2 MiB')
  await expect(stats).toContainText('of 12.5 GiB limit')
  await expect(stats).toContainText('3,137,200')
  // largest tables across databases, with a profile shortcut
  await expect(home.getByRole('region', { name: 'Largest tables' })).toContainText('trips')
  await expect(home.getByRole('region', { name: 'Memory by component' })).toContainText('base table')

  await home.getByRole('button', { name: /^Databases/ }).click()
  const dbs = page.getByTestId('duckdb-databases')
  await expect(dbs.getByRole('row')).toHaveCount(3) // header + warehouse + lake
  await expect(dbs).toContainText('read-only')
  const lake = dbs.getByRole('row').filter({ hasText: 'lake' })
  await lake.getByRole('button', { name: 'Detach' }).click()
  const dlg = page.getByRole('dialog', { name: 'Detach lake' })
  await expect(dlg).toContainText('DETACH DATABASE IF EXISTS "lake"')
  await dlg.getByRole('button', { name: 'Confirm' }).click()
  await expect(dlg).toHaveCount(0)
  await expect(dbs.getByRole('row')).toHaveCount(2)
  expect(errors).toEqual([])
})

test('duckdb workspace: install/load an extension and change a setting', async ({ page }) => {
  const errors = await open(page)
  await openHome(page, 'Extensions')
  const ext = page.getByTestId('duckdb-extensions')
  await expect(ext.locator('tr[data-ext="json"]')).toContainText('Loaded')
  await expect(ext.locator('tr[data-ext="json"]')).toContainText('built-in')
  const spatial = ext.locator('tr[data-ext="spatial"]')
  await expect(spatial).toContainText('Not installed')
  await spatial.getByRole('button', { name: 'Install & load' }).click()
  await expect(spatial).toContainText('Loaded')
  expect(await sqlLog(page)).toEqual(expect.arrayContaining(['INSTALL spatial', 'LOAD spatial']))
  // filter by status
  await page.getByRole('group', { name: 'Filter extensions' }).getByRole('button', { name: 'Not installed' }).click()
  await expect(ext.locator('tr[data-ext="spatial"]')).toHaveCount(0)
  await expect(ext.locator('tr[data-ext="excel"]')).toBeVisible()

  await page.getByTestId('duckdb-home').getByRole('button', { name: 'Settings' }).click()
  const set = page.getByTestId('duckdb-settings')
  await expect(set.locator('tr[data-setting]').first()).toHaveAttribute('data-setting', 'memory_limit') // common first
  await set.getByRole('textbox', { name: 'threads' }).fill('4')
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByText('Settings applied')).toBeVisible()
  expect(await sqlLog(page)).toContain("SET GLOBAL threads = '4'")
  await expect(set.getByRole('textbox', { name: 'threads' })).toHaveValue('4')
  // a bad value is reported by the engine, not swallowed
  await set.getByRole('textbox', { name: 'threads' }).fill('lots')
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByText(/threads: Conversion Error/)).toBeVisible()
  await set.locator('tr[data-setting="threads"]').getByRole('button', { name: 'Reset' }).click()
  await expect(set.getByRole('textbox', { name: 'threads' })).toHaveValue('8')
  expect(errors).toEqual([])
})

test('duckdb import wizard: detect → columns → new table, with the exact statement', async ({ page }) => {
  const errors = await open(page)
  await conn(page).click()
  await conn(page).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Import File…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Import file' })
  await expect(dlg).toBeVisible()
  // backdrop click does not close a form dialog
  await page.mouse.click(5, 5)
  await expect(dlg).toBeVisible()

  await dlg.getByLabel('File, folder pattern or URL').fill('/data/Sales 2026.csv')
  await expect(dlg.getByRole('radio', { name: /CSV/ })).toHaveAttribute('aria-checked', 'true')
  await dlg.getByLabel('Delimiter').selectOption(';')
  await dlg.getByRole('button', { name: 'Detect columns' }).click()
  await expect(dlg.getByTestId('duckdb-import-detected')).toContainText('4 columns')
  await expect(dlg.getByTestId('duckdb-import-detected')).toContainText('1,240 rows')
  await dlg.getByRole('button', { name: 'Next' }).click()

  // step 2: drop a column, re-type another; the preview grid shows the file
  await expect(dlg.getByTestId('duckdb-import-columns')).toContainText('customer')
  await dlg.getByLabel('Keep amount').uncheck()
  await dlg.getByLabel('Type of order_id').fill('INTEGER')
  await expect(dlg.getByRole('table').last()).toContainText('Bình')
  await dlg.getByRole('button', { name: 'Next' }).click()

  // step 3: name from the file, statement shown, then run
  await expect(dlg.getByLabel('Table name')).toHaveValue('sales_2026')
  const stmt = `CREATE TABLE "main"."sales_2026" AS SELECT CAST("order_id" AS INTEGER) AS "order_id", "customer", "ordered_at" FROM read_csv('/data/Sales 2026.csv', delim = ';')`
  await expect.poll(() => previewText(page, 'Import statement')).toBe(stmt)
  await dlg.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(dlg.getByTestId('duckdb-import-done')).toContainText('1,240')
  expect(await sqlLog(page)).toContain(stmt)
  // creating it again is refused before it runs
  await dlg.getByRole('button', { name: 'Import another file' }).click()
  await dlg.getByLabel('File, folder pattern or URL').fill('/data/Sales 2026.csv')
  await dlg.getByRole('button', { name: 'Detect columns' }).click()
  await dlg.getByRole('button', { name: 'Next' }).click()
  await dlg.getByRole('button', { name: 'Next' }).click()
  await expect(dlg.getByText(/already exists — choose Replace table or Append/)).toBeVisible()
  await dlg.getByRole('radio', { name: /Append to table/ }).click()
  await expect.poll(() => previewText(page, 'Import statement')).toMatch(/^INSERT INTO "main"\."sales_2026" BY NAME SELECT \* FROM read_csv/)
  await dlg.getByRole('button', { name: 'Cancel' }).click()
  await expect(dlg).toHaveCount(0)
  expect(errors).toEqual([])
})

test('duckdb import: a missing extension is offered for install, then detection works', async ({ page }) => {
  const errors = await open(page)
  await conn(page).click()
  await conn(page).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Import File…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Import file' })
  await dlg.getByLabel('File, folder pattern or URL').fill('/data/budget.xlsx')
  await expect(dlg.getByRole('radio', { name: /Excel/ })).toHaveAttribute('aria-checked', 'true')
  await dlg.getByRole('button', { name: 'Detect columns' }).click()
  await expect(dlg.getByRole('alert')).toContainText('exists in the excel extension')
  await dlg.getByRole('button', { name: 'Install & load excel' }).click()
  await expect(dlg.getByTestId('duckdb-import-detected')).toContainText('4 columns')
  // "Query the file instead" opens a SELECT over the reader in a query tab
  await dlg.getByRole('button', { name: /Query the file instead/ }).click()
  await expect(dlg).toHaveCount(0)
  await expect(page.locator('.view-lines').first()).toContainText("read_xlsx('/data/budget.xlsx')")
  expect(errors).toEqual([])
})

test('duckdb: table menu → Profile Data and Export to Parquet', async ({ page }) => {
  const errors = await open(page)
  await conn(page).click()
  await openDatabaseNode(page)
  const row = (name: string) => page.getByRole('treeitem').filter({ hasText: name })
  await row('main').first().dblclick()
  await row('Tables').first().dblclick()
  await row('events').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Profile Data' }).click()

  const prof = page.getByTestId('duckdb-profile')
  await expect(prof).toBeVisible()
  await expect(prof).toContainText('125,000 rows · 6 columns')
  const kind = prof.locator('article[data-column="kind"]')
  await expect(kind).toContainText('VARCHAR')
  await expect(kind.locator('.dk-top-row').first()).toContainText('view')
  const amount = prof.locator('article[data-column="amount"]')
  await expect(amount).toContainText('37.5%') // nulls
  await expect(amount.locator('.dk-hist > span')).toHaveCount(20)
  await expect(amount.getByLabel('Quartiles')).toBeVisible()
  // the raw SUMMARIZE grid is one click away
  await prof.getByRole('button', { name: 'Summary table' }).click()
  await expect(prof.getByText('null_percentage')).toBeVisible()

  await row('events').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Export to Parquet / CSV / JSON…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Export main.events' })
  await dlg.getByLabel('Destination file').fill('/exports/events.parquet')
  await dlg.getByTestId('duckdb-export-partition').getByText('kind').click()
  await expect(dlg.getByLabel('Destination folder')).toBeVisible()
  await dlg.getByLabel('Destination folder').fill('/exports/events')
  await expect.poll(() => previewText(page, 'Export statement')).toBe(
    `COPY "main"."events" TO '/exports/events' (FORMAT parquet, COMPRESSION zstd, PARTITION_BY ("kind"), OVERWRITE_OR_IGNORE true)`,
  )
  await dlg.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(dlg.getByTestId('duckdb-export-done')).toContainText('125,000')
  await dlg.getByRole('button', { name: 'Done' }).click()
  expect(errors).toEqual([])
})

test('duckdb: attach a database from the workspace — the tree gains it', async ({ page }) => {
  const errors = await open(page)
  await openHome(page)
  await page.getByTestId('duckdb-home').getByRole('button', { name: 'Attach database' }).click()
  const dlg = page.getByRole('dialog', { name: 'Attach database' })
  await dlg.getByLabel('Database file').fill('/data/Archive 2025.duckdb')
  await expect(dlg.getByLabel('Name (alias)')).toHaveValue('archive_2025')
  await dlg.getByText('Read-only').click()
  await expect.poll(() => previewText(page, 'Attach statement')).toBe(`ATTACH '/data/Archive 2025.duckdb' AS "archive_2025" (READ_ONLY)`)
  // a name already in use is refused before it runs
  await dlg.getByLabel('Name (alias)').fill('lake')
  await expect(dlg.getByText('A database named lake is already attached.')).toBeVisible()
  await expect(dlg.getByRole('button', { name: 'Attach', exact: true })).toBeDisabled()
  await dlg.getByLabel('Name (alias)').fill('archive_2025')
  await dlg.getByRole('button', { name: 'Attach', exact: true }).click()
  await expect(dlg).toHaveCount(0)
  await expect(page.getByRole('treeitem', { name: /archive_2025 database$/ })).toBeVisible()
  // SQLite needs the sqlite extension: the error offers to install it
  await page.getByTestId('duckdb-home').getByRole('button', { name: 'Attach database' }).click()
  await dlg.getByLabel('Database file').fill('/data/legacy.sqlite')
  await expect(dlg.getByRole('radiogroup', { name: 'Database type' }).getByRole('button', { name: 'SQLite' })).toHaveClass(/on/)
  await dlg.getByRole('button', { name: 'Attach', exact: true }).click()
  await dlg.getByRole('button', { name: 'Install & load sqlite_scanner' }).click()
  await expect(dlg).toHaveCount(0)
  await expect(page.getByRole('treeitem', { name: /legacy database$/ })).toBeVisible()
  expect(errors).toEqual([])
})
