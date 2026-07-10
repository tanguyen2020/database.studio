import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Phase C1 — CQL editor runs through the dedicated `cql_exec` path: server
// warnings (ALLOW FILTERING) surface in Messages, and paging state drives a
// "Load next page" button that appends the next window (never LIMIT/OFFSET).
test('cassandra: CQL warning + Load next page (paging)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)

  // double-click Cassandra connection → connect + open "Untitled CQL" editor
  await page.getByRole('button', { name: /Profiles Cassandra/ }).dblclick()
  await page.waitForTimeout(600)
  await expect(page.getByRole('tab', { name: /Untitled CQL/ }).first()).toBeVisible()

  // Phase C4 — per-statement consistency dropdown (Cassandra only)
  await expect(page.getByTitle('Consistency level for statements run from this editor')).toBeVisible()

  // run a full-scan query → server warning + first page (25 rows) + paging token
  await page.locator('.cm-content').first().click()
  await page.keyboard.type('SELECT * FROM students_by_id ALLOW FILTERING')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(500)

  await expect(page.getByText(/25 rows/).first()).toBeVisible()
  const loadMore = page.getByRole('button', { name: /Load next page/ })
  await expect(loadMore).toBeVisible()

  // load the next page → rows append to 50, paging token clears
  await loadMore.click()
  await page.waitForTimeout(400)
  await expect(page.getByText(/50 rows/).first()).toBeVisible()
  await expect(page.getByRole('button', { name: /Load next page/ })).toHaveCount(0)

  // ALLOW FILTERING warning logged to Messages
  await page.getByRole('tab', { name: /Messages/ }).first().click()
  await expect(page.getByText(/ALLOW FILTERING/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
