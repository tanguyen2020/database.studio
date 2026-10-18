import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Only statements that RETURN ROWS get a result tab. INSERT / UPDATE / DELETE /
// TRUNCATE / DDL are listed together in Messages — one tab per "✓ 1 affected"
// turned a script into a wall of tabs.

async function newQuery(page: Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(200)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(200)
}

async function run(page: Page, sql: string) {
  await page.locator('.view-lines').first().click()
  await page.keyboard.type(sql)
  await page.getByRole('button', { name: 'Run' }).first().click()
}

const resultTabs = (page: Page) => page.getByRole('tab', { name: /^#\d+/ })
const messagesTab = (page: Page) => page.getByRole('tab', { name: /^≣ Messages/ })

test('a DML/DDL script opens no result tabs — every statement is listed in Messages', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await newQuery(page)
  await run(
    page,
    "INSERT INTO students (first_name) VALUES ('Dung');\nUPDATE students SET status = 'x' WHERE id = 1;\nDELETE FROM courses WHERE id = 9;\nCREATE INDEX ix_s ON students (status);\nDROP INDEX ix_s;",
  )

  await expect(messagesTab(page)).toHaveAttribute('aria-selected', 'true')
  await expect(resultTabs(page)).toHaveCount(0)
  // one line per statement, named the way people say them, with its outcome
  await expect(page.locator('.rm-headline')).toHaveText('5 statements succeeded')
  await expect(page.locator('.rm-summary').getByText('14 rows affected')).toBeVisible()
  const list = page.getByRole('list')
  for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'CREATE INDEX', 'DROP INDEX']) {
    await expect(list.getByText(verb, { exact: true })).toBeVisible()
  }
  await expect(list.getByText('1 row affected').first()).toBeVisible()
  await expect(list.getByText('Completed').first()).toBeVisible()
  // the tab carries the statement count
  await expect(messagesTab(page)).toContainText('5')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('a mixed script opens a tab per SELECT only, and Messages links to them', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await newQuery(page)
  await run(page, "UPDATE students SET status = 'x' WHERE id = 1;\nSELECT * FROM students;\nDELETE FROM courses WHERE id = 9;\nSELECT * FROM courses;")

  await expect(resultTabs(page)).toHaveCount(2)
  await expect(page.getByRole('tab', { name: /^#2/ })).toBeVisible()
  await expect(page.getByRole('tab', { name: /^#4/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText(/Rows 1–3 of 3/)).toBeVisible()

  await messagesTab(page).click()
  await expect(page.locator('.rm-headline')).toHaveText('4 statements succeeded')
  await expect(page.locator('.rm-summary').getByText('2 result sets')).toBeVisible()
  // "3 rows returned ›" jumps to that statement's result tab
  await page.getByRole('button', { name: /rows returned/ }).first().click()
  await expect(page.getByRole('tab', { name: /^#2/ })).toHaveAttribute('aria-selected', 'true')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('a failing statement shows in Messages with its error, not as an error tab', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await newQuery(page)
  // the demo server refuses DROP SCHEMA … RESTRICT on a schema with objects in it
  await run(page, "UPDATE students SET status = 'x' WHERE id = 1;\nDROP SCHEMA public RESTRICT;")

  await expect(messagesTab(page)).toHaveAttribute('aria-selected', 'true')
  await expect(resultTabs(page)).toHaveCount(0)
  await expect(page.locator('.rm-headline')).toHaveText(/1 statement succeeded, 1 failed/)
  await expect(page.getByText(/cannot drop schema public/).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'View raw error' })).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Perf gate: outcomes are handed to the UI in batches, not one redraw per
// statement. Before, a 1,000-line INSERT script spent over 10 minutes redrawing
// the growing Messages list (demo backend answers instantly, so this measures the
// UI alone); now it takes about a second. 20 s leaves room for a loaded machine.
test('a 1,000-statement script finishes quickly (UI batches its updates)', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await newQuery(page)
  await page.locator('.view-lines').first().click()
  await page.evaluate(() => {
    type Ed = { getModel(): unknown; setValue(v: string): void }
    const eds = ((window as unknown as { __dsEditors?: Ed[] }).__dsEditors ?? []).filter((e) => e.getModel())
    eds[eds.length - 1].setValue(Array.from({ length: 1000 }, (_, i) => `INSERT INTO t (a) VALUES (${i});`).join('\n'))
  })
  const t0 = Date.now()
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForFunction(() => document.querySelector('.rm-headline')?.textContent?.includes('1,000 statements succeeded'), null, {
    timeout: 60_000,
    polling: 100,
  })
  const ms = Date.now() - t0
  expect(ms, `1,000 statements took ${ms} ms`).toBeLessThan(20_000)
  await expect(resultTabs(page)).toHaveCount(0)
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// A failure must say WHAT went wrong (plain title + the server's words + code),
// WHERE (the statement lines with the reported position marked), HOW to fix it,
// and which statements never ran because of it.
test('a failed statement explains the error: title, code, marked line, fix, statements not run', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await newQuery(page)
  await run(page, "UPDATE students SET status = 'x' WHERE id = 1;\nSELECT id,\n  first_name\nFROM no_such_table\nWHERE id = 1;\nDELETE FROM courses WHERE id = 9;")

  await expect(messagesTab(page)).toHaveAttribute('aria-selected', 'true')
  const card = page.getByRole('listitem', { name: 'Error details' })
  await expect(card).toBeVisible()
  await expect(card.getByText('Table or view not found')).toBeVisible()
  await expect(card.getByText('SQLSTATE 42P01')).toBeVisible()
  await expect(card.getByLabel('Server message')).toHaveText('relation "no_such_table" does not exist')
  // the reported line is marked, with a caret under the table name
  const where = card.getByLabel('Where the error is')
  await expect(where).toContainText('FROM no_such_table')
  await expect(where.locator('.rm-xl.hit')).toHaveCount(1)
  await expect(where.locator('.rm-xl.hit .rm-xn')).toHaveText('4')
  await expect(where.locator('.rm-caret')).toBeVisible()
  await expect(card.getByText(/How to fix/)).toBeVisible()
  await expect(card.getByRole('button', { name: 'Go to line 4' })).toBeVisible()
  // the DELETE after it never ran — said so, not silently missing
  await expect(page.getByText('1 statement not run')).toBeVisible()
  await expect(page.getByText(/1 statement after #2 was not run/)).toBeVisible()
  // the toast names the statement, the line and the kind of error
  await expect(page.getByText(/Statement #2 failed \(line 4\) — Table or view not found/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('a syntax error points at the typo; a clean run toast names what it did', async ({ page }) => {
  await newQuery(page)
  await run(page, 'SELEC * FROM students')
  const card = page.getByRole('listitem', { name: 'Error details' })
  await expect(card.getByText('Syntax error', { exact: true })).toBeVisible()
  await expect(card.getByLabel('Server message')).toHaveText('syntax error at or near "SELEC"')
  await expect(card.getByText('SQLSTATE 42601')).toBeVisible()
  await expect(page.getByText(/Query failed \(line 1\) — Syntax error/).first()).toBeVisible()

  // fix it and run again → the success toast says what came back
  await page.locator('.view-lines').first().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type("UPDATE students SET status = 'x' WHERE id = 1")
  await page.getByRole('button', { name: 'Run' }).first().click()
  await expect(page.getByText(/^1 row affected · \d+ ms$/).first()).toBeVisible()
})
