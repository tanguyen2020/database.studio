import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// User request — switching between open tabs must NOT re-execute anything; every
// tab keeps its state. Tabs stay mounted (hidden) once shown, so coming back
// shows the same results without a single extra backend call.

type Calls = Record<string, number>
const calls = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as { __ipcCalls?: Calls }).__ipcCalls ?? {})

test('switching tabs keeps results and never re-runs the query', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(200)
  await openDatabaseNode(page)

  // Tab A — run a query.
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(200)
  // Background tabs stay in the DOM (hidden) — always drive the visible editor.
  await page.locator('.cm-content:visible').first().click()
  await page.keyboard.type('SELECT * FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(500)
  await expect(page.getByText(/Rows 1–3 of 3/).first()).toBeVisible()
  const tabA = await page.getByRole('tab').filter({ hasText: /Untitled/ }).last().textContent()
  const afterRun = await calls(page)

  // Tab B — a second editor, typed but never run.
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(200)
  await page.locator('.cm-content:visible').first().click()
  await page.keyboard.type('SELECT 42')
  // A's results are not on screen while B is active.
  await expect(page.getByText(/Rows 1–3 of 3/).first()).toBeHidden()

  // Back to A — results are still there, and no statement was executed again.
  await page.getByRole('tab').filter({ hasText: tabA! }).first().click()
  await page.waitForTimeout(400)
  await expect(page.getByText(/Rows 1–3 of 3/).first()).toBeVisible()
  const afterSwitch = await calls(page)
  expect(afterSwitch['exec_statement'] ?? 0).toBe(afterRun['exec_statement'] ?? 0)

  // And B kept its unsaved text (it was not torn down and rebuilt).
  await page.getByRole('tab').filter({ hasText: /Untitled/ }).last().click()
  await page.waitForTimeout(300)
  await expect(page.locator('.cm-content:visible').first()).toContainText('SELECT 42')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('switching to a Table Viewer tab and back does not re-fetch its rows', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(200)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('students', { exact: true }).first().dblclick()
  await page.waitForTimeout(600)
  const loaded = await calls(page)
  expect(loaded['exec_filtered'] ?? 0).toBeGreaterThan(0)

  // Open another tab, then come back — the viewer must not query again.
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(300)
  await page.getByRole('tab').filter({ hasText: 'students' }).first().click()
  await page.waitForTimeout(500)
  const back = await calls(page)
  expect(back['exec_filtered']).toBe(loaded['exec_filtered'])

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
