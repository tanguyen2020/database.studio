import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// The editor's own keymap, after the move to Monaco. Monaco ships defaults that
// collide with two of these — Ctrl+Enter inserts a line below, Ctrl+Shift+K deletes
// a line — so this pins that the app's bindings win (and that Ctrl+Enter runs
// WITHOUT editing the document, which is how the collision would show up).

async function openSqlTab(page: import('@playwright/test').Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(600)
  const content = page.locator('.view-lines').first()
  await content.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  return content
}

test('Ctrl+Enter runs the statement at the cursor and leaves the document alone', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const content = await openSqlTab(page)

  await page.keyboard.type('SELECT * FROM students;')
  await page.keyboard.press('Escape') // close any suggestion popup
  // wait for the rendered text to settle before snapshotting it (Monaco paints
  // asynchronously, so reading innerText too early can catch a partial line)
  await expect(content).toContainText('SELECT * FROM students;')
  const before = (await content.innerText()).trim()

  await page.keyboard.press('Control+Enter')
  await page.waitForTimeout(900)

  // it ran…
  await expect(page.getByText(/Rows 1–3 of 3/).first()).toBeVisible()
  // …and Monaco's own Ctrl+Enter (insert line below) did NOT fire
  expect((await content.innerText()).trim()).toBe(before)
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('F5 runs, and Ctrl+Shift+F formats through the editor binding', async ({ page }) => {
  const content = await openSqlTab(page)

  await page.keyboard.type('select id,name from students')
  await page.keyboard.press('Escape')
  await page.keyboard.press('F5')
  await page.waitForTimeout(900)
  await expect(page.getByText(/Rows 1–3 of 3/).first()).toBeVisible()

  await page.keyboard.press('Control+Shift+KeyF')
  await page.waitForTimeout(500)
  // sql-formatter upper-cases keywords and breaks the clause onto its own line
  await expect(content).toContainText('SELECT')
  await expect(content).toContainText('FROM')
})

test('Ctrl+Shift+K reaches the app (filter connections) instead of deleting a line', async ({ page }) => {
  const content = await openSqlTab(page)
  await page.keyboard.type('SELECT 1')
  await page.keyboard.press('Escape')

  await page.keyboard.press('Control+Shift+KeyK')
  await page.waitForTimeout(400)

  // the line survives (Monaco's deleteLines would have removed it)…
  await expect(content).toContainText('SELECT 1')
  // …and the app's shortcut ran: the connections filter box is focused
  await expect(page.getByPlaceholder('Filter by name, host, database…')).toBeFocused()
})
