import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// User request — a freshly opened Query tab shows NO result panel; the editor
// fills the pane until a statement (or Explain) runs, which auto-reveals it.
// After results are shown, the X in the header hides the panel and Ctrl/Cmd+J
// toggles it back.
test('result panel: hidden on new tab, auto-shows on Run, X + Ctrl+J toggle', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(200)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(200)

  // New tab → no result panel yet (nothing has run).
  const grid = page.getByText(/Rows 1–3 of 3/)
  await expect(grid).toHaveCount(0)
  await expect(page.getByTitle('Hide Result panel (Ctrl+J)')).toHaveCount(0)

  // Run → the panel auto-reveals with results.
  await page.locator('.cm-content').first().click()
  await page.keyboard.type('SELECT * FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(500)
  await expect(grid.first()).toBeVisible()

  // X in the result header hides it (results gone from view).
  await page.getByTitle('Hide Result panel (Ctrl+J)').first().click()
  await expect(grid).toHaveCount(0)

  // Ctrl+J toggles it back on (results still there).
  await page.keyboard.press('Control+j')
  await expect(grid.first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
