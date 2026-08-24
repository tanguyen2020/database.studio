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
  await page.locator('.view-lines:visible').first().click()
  await page.keyboard.type('SELECT * FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(500)
  await expect(page.getByText(/Rows 1–3 of 3/).first()).toBeVisible()
  const tabA = await page.getByRole('tab').filter({ hasText: /Untitled/ }).last().textContent()
  const afterRun = await calls(page)

  // Tab B — a second editor, typed but never run.
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(200)
  await page.locator('.view-lines:visible').first().click()
  await page.keyboard.type('SELECT 42')
  // A's results are not on screen while B is active.
  await expect(page.getByText(/Rows 1–3 of 3/).first()).toBeHidden()

  // Back to A — results are still there, and no statement was executed again.
  await page.getByRole('tab').filter({ hasText: tabA! }).first().click()
  await page.waitForTimeout(400)
  await expect(page.getByText(/Rows 1–3 of 3/).first()).toBeVisible()
  // …and the ROWS are painted, not just the footer: a hidden tab must keep a real
  // box so the virtualized grid still has a viewport to render into (the reported
  // bug was an empty grid until you nudged the scroll wheel).
  await expect(page.getByText('Binh', { exact: true }).first()).toBeVisible()
  const afterSwitch = await calls(page)
  expect(afterSwitch['exec_statement'] ?? 0).toBe(afterRun['exec_statement'] ?? 0)

  // And B kept its unsaved text (it was not torn down and rebuilt).
  await page.getByRole('tab').filter({ hasText: /Untitled/ }).last().click()
  await page.waitForTimeout(300)
  await expect(page.locator('.view-lines:visible').first()).toContainText('SELECT 42')

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

// The reported bug: after switching away and back, the grid came up EMPTY — the
// header and the row count were there, but no rows, until a nudge of the scroll
// wheel painted them. A hidden tab must keep a real box: the grid is virtualized,
// and a zero-height viewport means "render no rows".
test('a big result is still painted after switching tabs (no scroll nudge)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(200)
  await openDatabaseNode(page)

  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(200)
  await page.locator('.view-lines:visible').first().click()
  await page.keyboard.type('SELECT * FROM perf_rows_1000')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(800)
  const firstCell = page.getByText('42261', { exact: true })
  await expect(firstCell.first()).toBeVisible()
  const rowsBefore = await page.locator('tr:visible').count()
  expect(rowsBefore).toBeGreaterThan(5)

  // Away…
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(400)
  // …and back: the rows are on screen immediately, no scrolling involved.
  await page.getByRole('tab').filter({ hasText: /Untitled/ }).first().click()
  await page.waitForTimeout(500)
  await expect(firstCell.first()).toBeVisible()
  expect(await page.locator('tr:visible').count()).toBeGreaterThan(5)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Root cause of that empty grid: a background tab kept in the DOM with
// display:none has NO box, so anything that measures its viewport (the
// virtualized grid, Monaco) computes "nothing fits" while hidden and only
// recovers on the next scroll/resize. A hidden tab must stay laid out.
test('a background tab keeps a real box while hidden', async ({ page }) => {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(200)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(200)
  await page.locator('.view-lines:visible').first().click()
  await page.keyboard.type('SELECT * FROM perf_rows_1000')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(700)

  const active = page.locator('[data-tab-pane][data-active="true"]')
  const activeBox = await active.first().boundingBox()

  // switch away — the tab we just ran is now a background tab
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(400)

  const hidden = page.locator('[data-tab-pane][data-active="false"]')
  expect(await hidden.count()).toBeGreaterThan(0)
  const hiddenBox = await hidden.first().boundingBox()
  expect(hiddenBox, 'a hidden tab must still be laid out').not.toBeNull()
  expect(hiddenBox!.height).toBeGreaterThan(100)
  expect(Math.round(hiddenBox!.height)).toBe(Math.round(activeBox!.height))
  // laid out, yet not visible to the user (and not clickable)
  await expect(hidden.first()).toBeHidden()
})

// The reported bug, exactly: run a query, scroll the grid, look at another tab,
// come back — the grid was blank until the wheel nudged it. A hidden box loses
// its scroll offset in the browser while the virtualized grid keeps the offset
// it last saw, so it painted a tall empty spacer above rows that were no longer
// reachable. Coming back must show rows, at the same place you left them.
test('a scrolled grid comes back painted, at the same scroll position', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(200)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(200)
  await page.locator('.view-lines:visible').first().click()
  await page.keyboard.type('SELECT * FROM perf_rows_1000')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(800)

  const gridState = () =>
    page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('div')).find(
        (d) => d.scrollHeight > d.clientHeight + 50 && !!d.querySelector('table') && !!d.closest('[data-active="true"]'),
      ) as HTMLElement | undefined
      const painted = Array.from(document.querySelectorAll('[data-active="true"] tbody tr')).filter((r) => {
        const b = r.getBoundingClientRect()
        return b.height > 0 && b.bottom > 0 && b.top < window.innerHeight
      }).length
      return { scrollTop: el?.scrollTop ?? -1, painted }
    })

  await page.mouse.move(600, 600)
  await page.mouse.wheel(0, 1200)
  await page.waitForTimeout(400)
  const before = await gridState()
  expect(before.scrollTop, 'the grid actually scrolled').toBeGreaterThan(200)
  expect(before.painted, 'rows are on screen before switching').toBeGreaterThan(5)

  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(500)
  await page.getByRole('tab').filter({ hasText: /Untitled/ }).first().click()
  await page.waitForTimeout(600)

  const after = await gridState()
  expect(after.scrollTop, 'scroll position is where the user left it').toBe(before.scrollTop)
  expect(after.painted, 'rows are painted without touching the wheel').toBeGreaterThan(5)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
