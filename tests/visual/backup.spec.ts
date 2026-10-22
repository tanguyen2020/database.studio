import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Backup & Restore — every engine's database node offers ONE "Backup & Restore…"
// item in its context menu (the dialog has Backup / Restore tabs), and the dialog runs, reports and restores. The demo
// backend (src/lib/backup/demo.ts) answers with the real command shapes.

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls ?? {})

async function boot(page: Page, query = '') {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL + query)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  return errors
}

/** Some demo profiles start disconnected (MSSQL) — open them like a user would. */
async function connectIfNeeded(page: Page) {
  const c = page.getByRole('button', { name: 'Connect', exact: true })
  if (await c.count()) {
    await c.first().click()
    await page.waitForTimeout(600)
  }
}

async function openFromMenu(page: Page, node: ReturnType<Page['locator']>, item: RegExp) {
  await expect(node).toBeVisible()
  await node.click({ button: 'right' })
  await page.waitForTimeout(200)
  const mi = page.getByRole('menuitem', { name: item })
  await expect(mi).toBeVisible()
  await mi.click()
  const dialog = page.getByRole('dialog', { name: 'Backup & Restore' })
  await expect(dialog).toBeVisible()
  return dialog
}

// ---- every engine: the database node's own context menu --------------------
/** The progress window a job opens in (the configuration dialog closes). */
const progressWindow = (page: Page) => page.getByRole('dialog', { name: /^(Backup|Restore) of / })

const ENGINES: {
  name: string
  conn: (p: Page) => ReturnType<Page['locator']>
  node: (p: Page) => ReturnType<Page['locator']>
  db: RegExp
  query?: string
  noun?: string
  setup?: (p: Page) => Promise<void>
}[] = [
  { name: 'PostgreSQL · current database', conn: (p) => p.getByRole('button', { name: /Postgres/ }).first(), node: (p) => p.getByRole('treeitem', { name: /\bcurrent$/ }).first(), db: /app/ },
  { name: 'PostgreSQL · other database', conn: (p) => p.getByRole('button', { name: /Postgres/ }).first(), node: (p) => p.getByRole('treeitem', { name: /^analytics/ }).first(), db: /analytics/ },
  { name: 'SQL Server', conn: (p) => p.getByRole('button', { name: /MSSQL/ }).first(), node: (p) => p.getByRole('treeitem', { name: /\bcurrent$/ }).first(), db: /·/ },
  { name: 'Oracle', conn: (p) => p.getByText('10.0.7.1', { exact: false }).first(), node: (p) => p.getByRole('treeitem', { name: /\bcurrent$/ }).first(), db: /·/ },
  { name: 'MySQL (database = schema node)', conn: (p) => p.getByText('localhost:3306', { exact: false }).first(), node: (p) => p.getByRole('treeitem', { name: /^public/ }).first(), db: /public/ },
  { name: 'MariaDB', conn: (p) => p.getByRole('button', { name: /MariaDB App/ }).first(), node: (p) => p.getByRole('treeitem', { name: /^public/ }).first(), db: /·/ },
  { name: 'ClickHouse', conn: (p) => p.getByRole('button', { name: /Analytics ClickHouse/ }).first(), node: (p) => p.getByRole('treeitem', { name: /^public/ }).first(), db: /public/ },
  { name: 'SQLite (file node)', conn: (p) => p.getByRole('button', { name: /Local SQLite/ }).first(), node: (p) => p.getByRole('treeitem', { name: /\bfile$/ }).first(), db: /Local SQLite|Backup/ },
  { name: 'Cassandra (keyspace)', conn: (p) => p.getByRole('button', { name: /Profiles Cassandra/ }).first(), node: (p) => p.getByRole('treeitem', { name: /library_ks/ }).first(), db: /library_ks/, noun: 'Keyspace' },
  { name: 'MongoDB', conn: (p) => p.getByRole('button', { name: /Events MongoDB/ }).first(), node: (p) => p.locator('[aria-label="Explorer"], aside').getByText('analytics', { exact: true }).first(), db: /analytics/ },
  { name: 'Redis (connection row — Redis has no object tree)', conn: (p) => p.getByRole('button', { name: /Cache Redis/ }).first(), node: (p) => p.getByRole('button', { name: /Cache Redis/ }).first(), db: /db0/ },
  { name: 'DuckDB', query: '?duckdb=1', conn: (p) => p.getByRole('button', { name: /Warehouse DuckDB/ }).first(), node: (p) => p.getByRole('treeitem', { name: /\bcurrent$/ }).first(), db: /·/ },
]

for (const e of ENGINES) {
  test(`database node context menu → Backup / Restore: ${e.name}`, async ({ page }) => {
    const errors = await boot(page, e.query)
    await e.conn(page).click()
    await page.waitForTimeout(600)
    await connectIfNeeded(page)
    await openDatabaseNode(page)
    const noun = e.noun ?? 'Database'
    // one menu item — not a separate Backup… and Restore…
    await e.node(page).click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Backup & Restore…' })).toHaveCount(1)
    await expect(page.getByRole('menuitem', { name: new RegExp(`^(Backup|Restore) ${noun}…$`) })).toHaveCount(0)
    await page.keyboard.press('Escape')
    const dialog = await openFromMenu(page, e.node(page), /^Backup & Restore…$/)
    await expect(dialog.getByRole('tab', { name: /Backup/ })).toHaveAttribute('aria-selected', 'true')
    await expect(dialog.locator('.um-dlg-title span')).toHaveText(e.db)
    // a method card that says what will run, and a Back up button
    await expect(dialog.locator('.bk-method')).toBeVisible()
    await expect(dialog.getByRole('button', { name: /Back up/ })).toBeVisible()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // the same popup restores: switch to its Restore tab
    const d2 = await openFromMenu(page, e.node(page), /^Backup & Restore…$/)
    await d2.getByRole('tab', { name: /Restore/ }).click()
    await expect(d2.getByRole('tab', { name: /Restore/ })).toHaveAttribute('aria-selected', 'true')
    await expect(d2.getByRole('button', { name: /^Restore$/ })).toHaveAttribute('aria-disabled', 'true')
    expect(errors, errors.join('\n')).toEqual([])
  })
}

test('connections list: Backup & Restore… only for engines that back up', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /Events Kafka/ }).first().click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Users & Privileges…' }).or(page.getByRole('menuitem', { name: 'Refresh' })).first()).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Backup & Restore…' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /Cache Redis/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Backup & Restore…' }).click()
  await expect(page.getByRole('dialog', { name: 'Backup & Restore' })).toBeVisible()
})

// ---- the full flow on PostgreSQL (a production connection) -----------------
test('PostgreSQL: back up, then restore that file straight from the result', async ({ page }) => {
  const errors = await boot(page)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  const dialog = await openFromMenu(page, page.getByRole('treeitem', { name: /\bcurrent$/ }).first(), /^Backup & Restore…$/)

  // backdrop never closes a form dialog
  await page.mouse.click(8, 8)
  await expect(dialog).toBeVisible()

  // the tool that will run, found in its install folder (not only PATH)
  await expect(dialog.locator('.bk-method')).toContainText('pg_dump (PostgreSQL) 16.4')
  await expect(dialog.locator('.bk-method')).toContainText('PostgreSQL\\16\\bin')
  await expect(dialog.locator('.bk-chip.ok')).toHaveText(/Ready/)

  // a full default path in the user's backup folder, named after the database
  const file = dialog.getByLabel('Backup file')
  await expect(file).toHaveValue(/Database Studio\\Backups\\app_\d{4}-\d{2}-\d{2}_\d{4}\.sql$/)
  // switching format swaps the extension, keeping the name
  await dialog.getByRole('radio', { name: /Custom archive/ }).click()
  await expect(file).toHaveValue(/\.dump$/)
  // what to include: three named cards, one checked, the summary says it in words
  const include = dialog.getByRole('radiogroup', { name: 'What to include' })
  await expect(include.getByRole('radio')).toHaveText([/Structure only/, /Structure and data/, /Data only/])
  // the popup opens on Structure only
  await expect(include.getByRole('radio', { name: /Structure only/ })).toHaveAttribute('aria-checked', 'true')
  await expect(include.getByRole('radio', { name: /Structure and data/ })).toHaveAttribute('aria-checked', 'false')
  await include.getByRole('radio', { name: /Structure and data/ }).click()
  await expect(include.getByRole('radio', { name: /Structure and data/ })).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByLabel('Backup summary')).toContainText('structure and data')
  await include.getByRole('radio', { name: /Structure only/ }).click()
  await expect(include.getByRole('radio', { name: /Structure only/ })).toHaveAttribute('aria-checked', 'true')
  const summary = dialog.getByLabel('Backup summary')
  await expect(summary).toContainText('Backs up app — structure only, as Custom archive, to app_')
  // steps are numbered in reading order
  await expect(dialog.locator('.um-group-title')).toHaveText(['Source', 'What to include', 'Format & options', 'Save to'])

  await dialog.getByRole('button', { name: /Back up/ }).click()
  // the configuration dialog closes; the job has its own progress window
  await expect(dialog).toHaveCount(0)
  const win = progressWindow(page)
  await expect(win).toBeVisible()
  await expect(win).toContainText('Backup complete')
  await expect(win).toContainText('18 MB')
  // the backdrop never closes it either
  await page.mouse.click(8, 8)
  await expect(win).toBeVisible()
  expect((await calls(page)).backup_database).toBe(1)

  // straight from the result to its restore
  await win.getByRole('button', { name: 'Restore from this file…' }).click()
  await expect(win).toHaveCount(0)

  // Restore tab, file pre-filled; two tabs only, no confirmation to type
  await expect(dialog.getByRole('tab')).toHaveText([/Backup/, /Restore/])
  await expect(dialog.getByRole('tab', { name: /Restore/ })).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.getByLabel('Backup file to restore')).toHaveValue(/\.dump$/)
  await expect(dialog).toContainText('Custom archive — restored with pg_restore')
  // what it overwrites is still said, plainly
  await expect(dialog.locator('.bk-danger')).toContainText('Runs the backup into app')
  await expect(dialog.locator('.bk-danger')).toContainText('production connection')
  await expect(dialog.getByLabel('Type the database name to confirm')).toHaveCount(0)
  await expect(dialog.getByRole('checkbox', { name: /I understand/ })).toHaveCount(0)
  const restore = dialog.getByRole('button', { name: /^Restore$/ })
  await expect(restore).toHaveAttribute('aria-disabled', 'false')
  await restore.click()
  await expect(dialog).toHaveCount(0)
  await expect(progressWindow(page)).toContainText('Restore complete')
  expect((await calls(page)).restore_database).toBe(1)
  await progressWindow(page).getByRole('button', { name: 'Close', exact: true }).click()
  await expect(progressWindow(page)).toHaveCount(0)
  expect(errors, errors.join('\n')).toEqual([])
})

test('a missing client tool explains what to install and can be located', async ({ page }) => {
  await boot(page, '?backupNoTool=1')
  await page.getByText('localhost:3306', { exact: false }).first().click()
  await page.waitForTimeout(500)
  const dialog = await openFromMenu(page, page.getByRole('treeitem', { name: /^public/ }).first(), /^Backup & Restore…$/)
  await expect(dialog.locator('.bk-chip.warn')).toHaveText(/Not ready/)
  await expect(dialog).toContainText('Install the mysql client tools')
  await expect(dialog.getByRole('button', { name: /Back up/ })).toHaveAttribute('aria-disabled', 'true')
  await dialog.getByLabel('Client tools folder').fill('D:\\tools\\mysql\\bin')
  await dialog.getByRole('button', { name: 'Check again' }).click()
  await expect(dialog.locator('.bk-chip.ok')).toHaveText(/Ready/)
  await expect(dialog.locator('.bk-method')).toContainText('D:\\tools\\mysql\\bin')
  await expect(dialog.getByRole('button', { name: /Back up/ })).toHaveAttribute('aria-disabled', 'false')
})

test('a running backup shows progress in its own window and can be stopped', async ({ page }) => {
  await boot(page, '?slowBackup=6000')
  // Redis opens its Browser workspace; Backup & Restore… is a button there
  await page.getByRole('button', { name: /Cache Redis/ }).first().click()
  await page.locator('[data-stream-shell="redis"]').getByRole('button', { name: 'Backup & Restore…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Backup & Restore' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Backup file')).toHaveValue(/redis_db0_.*\.redis\.jsonl$/)
  await dialog.getByRole('button', { name: /Back up/ }).click()
  await expect(dialog).toHaveCount(0)
  const win = progressWindow(page)
  await expect(win).toContainText('Backing up db0')
  await expect(win.getByRole('progressbar', { name: 'Backup progress' })).toBeVisible()
  // it stays until the job ends: no close, no background mode — only Stop
  await expect(win.getByRole('button', { name: 'Close dialog' })).toHaveCount(0)
  await expect(win.getByRole('button', { name: /background/i })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.mouse.click(8, 8)
  await expect(win).toBeVisible()
  await win.getByRole('button', { name: 'Stop' }).click()
  await expect(win).toContainText('Backup stopped')
  await expect(win).toContainText('Cancelled')
  await expect(win).toContainText('Nothing half-written was kept')
  expect((await calls(page)).cancel_backup).toBe(1)
  await win.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(win).toHaveCount(0)
})

test('SQL Server: the file is on the server; recent backups can be picked', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /MSSQL/ }).first().click()
  await page.waitForTimeout(500)
  await connectIfNeeded(page)
  await openDatabaseNode(page)
  const dialog = await openFromMenu(page, page.getByRole('treeitem', { name: /\bcurrent$/ }).first(), /^Backup & Restore…$/)
  await dialog.getByRole('tab', { name: /Restore/ }).click()
  await expect(dialog.locator('.bk-method')).toContainText('Native BACKUP DATABASE')
  await expect(dialog.locator('.bk-method')).toContainText("on the server's disk")
  await dialog.locator('.bk-recent-row').first().click()
  await expect(dialog.getByLabel('Backup file to restore')).toHaveValue(/\/var\/opt\/mssql\/data\/.*\.bak$/)
  await expect(dialog).toContainText('Every open session in it is disconnected')
  // the non-production MSSQL connection confirms with a checkbox
  await dialog.getByRole('button', { name: /^Restore$/ }).click()
  await expect(progressWindow(page)).toContainText('Restore complete')
})

test('a failing tool shows the plain-language reason and the raw output', async ({ page }) => {
  await boot(page, '?backupFail=1')
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  const dialog = await openFromMenu(page, page.getByRole('treeitem', { name: /\bcurrent$/ }).first(), /^Backup & Restore…$/)
  await dialog.getByRole('button', { name: /Back up/ }).click()
  const win = progressWindow(page)
  await expect(win).toContainText('Backup failed')
  await expect(win).toContainText('older than the server')
  await expect(win).toContainText('aborting because of server version mismatch')
  await win.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(win).toHaveCount(0)
})

test('toolbar Backup & Restore button still opens the dialog', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await openDatabaseNode(page)
  await page.getByRole('treeitem', { name: /^public/ }).first().click()
  await page.getByTitle(/Backup & Restore/).first().click()
  await expect(page.getByRole('dialog', { name: 'Backup & Restore' })).toBeVisible()
})

test('the tools shipped with the app are used and named as such; the popup is wide enough for full paths', async ({ page }) => {
  await boot(page, '?backupBundled=1')
  await page.getByText('localhost:3306', { exact: false }).first().click()
  await page.waitForTimeout(500)
  const dialog = await openFromMenu(page, page.getByRole('treeitem', { name: /^public/ }).first(), /^Backup & Restore…$/)
  const card = dialog.locator('.bk-method')
  await expect(card).toContainText('Included with Database Studio')
  await expect(card.locator('.bk-bundled')).toHaveAttribute('title', /resources\\tools\\mariadb\\bin/)
  await expect(dialog.locator('.bk-chip.ok')).toHaveText(/Ready/)
  // nothing to install, so no install hint and no folder picker by default
  await expect(dialog.locator('.bk-locate')).toHaveCount(0)
  // wide popup, no text in it cut off with an ellipsis
  const width = await dialog.evaluate((el) => el.getBoundingClientRect().width)
  expect(width).toBeGreaterThanOrEqual(700)
  const clipped = await dialog.evaluate((root) =>
    Array.from(root.querySelectorAll<HTMLElement>('*'))
      .filter((el) => el.children.length === 0 && (el.innerText ?? '').trim() && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow === 'ellipsis')
      .map((el) => el.innerText),
  )
  expect(clipped).toEqual([])
})

test('SQL Server: export to this computer as a .bacpac with the bundled SqlPackage, and import it back', async ({ page }) => {
  const errors = await boot(page)
  await page.getByRole('button', { name: /MSSQL/ }).first().click()
  await page.waitForTimeout(500)
  await connectIfNeeded(page)
  await openDatabaseNode(page)
  const dialog = await openFromMenu(page, page.getByRole('treeitem', { name: /\bcurrent$/ }).first(), /^Backup & Restore…$/)

  // two places to keep it: the server (.bak) — still the default — or here (.bacpac)
  await expect(dialog.getByRole('radio', { name: /Backup on the server \(\.bak\)/ })).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByLabel('Backup file')).toHaveValue(/^\/var\/opt\/mssql\/data\/.*\.bak$/)
  await dialog.getByRole('radio', { name: /Export to this computer \(\.bacpac\)/ }).click()
  const card = dialog.locator('.bk-method')
  await expect(card).toContainText('Included with Database Studio')
  await expect(card).not.toContainText("on the server's disk")
  await expect(dialog.locator('.bk-chip.ok')).toHaveText(/Ready/)
  // the path moves to this computer, and server-only options go away
  await expect(dialog.getByLabel('Backup file')).toHaveValue(/^C:\\Users\\demo\\Documents\\Database Studio\\Backups\\.*\.bacpac$/)
  await expect(dialog.getByText('Copy-only backup')).toHaveCount(0)
  await expect(dialog).toContainText('Saved on this computer')
  await dialog.getByRole('button', { name: /Back up/ }).click()
  await expect(progressWindow(page)).toContainText('Backup complete')
  // straight from the result to its restore
  await progressWindow(page).getByRole('button', { name: 'Restore from this file…' }).click()
  await expect(progressWindow(page)).toHaveCount(0)

  // restore: pick "File on this computer", then a new name or drop-first
  await expect(dialog.getByRole('tab', { name: /Restore/ })).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.locator('.bk-recent-row').first()).toBeVisible()
  await dialog.getByRole('button', { name: 'File on this computer (.bacpac)' }).click()
  await expect(dialog.locator('.bk-recent-row')).toHaveCount(0)
  await expect(dialog.getByLabel('Restore as')).toBeVisible()
  await expect(dialog.getByText('Drop the target database first')).toBeVisible()
  await expect(dialog).toContainText('must be new or empty')
  await dialog.getByLabel('Backup file to restore').fill('C:\\Users\\demo\\Documents\\Database Studio\\Backups\\app.bacpac')
  await expect(dialog).toContainText('imported with SqlPackage')
  await dialog.getByLabel('Restore as').fill('app_copy')
  await dialog.getByRole('button', { name: /^Restore$/ }).click()
  await expect(progressWindow(page)).toContainText('Restore complete')
  expect(errors, errors.join('\n')).toEqual([])
})

test('3,000 tables: progress counts through them with the current table, rate and time left, and Stop ends it', async ({ page }) => {
  const errors = await boot(page, '?slowBackup=6000&backupTables=3000')
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  const dialog = await openFromMenu(page, page.getByRole('treeitem', { name: /\bcurrent$/ }).first(), /^Backup & Restore…$/)
  await dialog.getByRole('button', { name: /Back up/ }).click()
  const win = progressWindow(page)
  const bar = win.getByRole('progressbar', { name: 'Backup progress' })
  await expect(bar).toBeVisible()
  // a real percentage, moving forward
  await expect.poll(async () => Number(await bar.getAttribute('aria-valuenow') ?? -1), { timeout: 4000 }).toBeGreaterThan(5)
  const first = Number(await bar.getAttribute('aria-valuenow'))
  await expect.poll(async () => Number(await bar.getAttribute('aria-valuenow') ?? -1), { timeout: 4000 }).toBeGreaterThan(first)
  const box = win
  await expect(box).toContainText(/[\d,]+ of 3,000 tables/)
  await expect(box).toContainText(/public\.table_\d{4}/)
  await expect(box).toContainText(/tables\/s/)
  await expect(box).toContainText(/left/)
  await expect(box).toContainText(/elapsed/)
  const t0 = Date.now()
  await win.getByRole('button', { name: 'Stop' }).click()
  // "Stopping…" lasts only as long as the kill takes (well under a frame) — assert the outcome
  await expect(win).toContainText('Cancelled')
  expect((await calls(page)).cancel_backup).toBe(1)
  expect(Date.now() - t0).toBeLessThan(3000)
  await expect(bar).toHaveCount(0)
  expect(errors, errors.join('\n')).toEqual([])
})

test('SQL Server: a native RESTORE reports the server percent and says it cannot be stopped', async ({ page }) => {
  await boot(page, '?slowBackup=3000')
  await page.getByRole('button', { name: /MSSQL/ }).first().click()
  await page.waitForTimeout(500)
  await connectIfNeeded(page)
  await openDatabaseNode(page)
  const dialog = await openFromMenu(page, page.getByRole('treeitem', { name: /\bcurrent$/ }).first(), /^Backup & Restore…$/)
  await dialog.getByRole('tab', { name: /Restore/ }).click()
  await dialog.locator('.bk-recent-row').first().click()
  await dialog.getByRole('button', { name: /^Restore$/ }).click()
  const win = progressWindow(page)
  const bar = win.getByRole('progressbar', { name: 'Restore progress' })
  await expect.poll(async () => Number(await bar.getAttribute('aria-valuenow') ?? -1), { timeout: 3000 }).toBeGreaterThan(0)
  await expect(win).toContainText(/\d+%/)
  await expect(win.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  await expect(win).toContainText('Cannot be stopped once SQL Server starts restoring')
  await expect(win).toContainText('Restore complete')
})

test('the database pickers are searchable and drive the file name and the summary', async ({ page }) => {
  const errors = await boot(page)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  const dialog = await openFromMenu(page, page.getByRole('treeitem', { name: /\bcurrent$/ }).first(), /^Backup & Restore…$/)

  // Backup: type to narrow the list, pick with the keyboard
  const pick = dialog.getByLabel('Database to back up')
  await expect(pick).toHaveAttribute('placeholder', 'app')
  await pick.click()
  await pick.fill('ana')
  const options = page.getByRole('option')
  await expect(options).toHaveCount(1)
  await expect(options.first()).toHaveText('analytics')
  await pick.press('Enter')
  await expect(dialog.getByLabel('Backup file')).toHaveValue(/analytics_\d{4}-\d{2}-\d{2}_\d{4}\.sql$/)
  await expect(dialog.getByLabel('Backup summary')).toContainText('Backs up analytics — structure only, as SQL script, to analytics_')

  // Restore: the same searchable picker
  await dialog.getByRole('tab', { name: /Restore/ }).click()
  const into = dialog.getByLabel('Restore into')
  await into.click()
  await into.fill('zzz')
  await expect(page.getByRole('option')).toHaveCount(0)
  await into.fill('ap')
  await expect(page.getByRole('option')).toHaveText(['app'])
  await page.getByRole('option', { name: 'app' }).click()
  await expect(dialog.locator('.bk-danger')).toContainText('Runs the backup into app.')
  expect(errors, errors.join('\n')).toEqual([])
})
