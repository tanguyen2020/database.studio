import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// User request — the Result panel can be toggled (button + Ctrl/Cmd+J). When it
// is hidden, running a statement (or Explain) auto-reveals it.
test('result panel: toggle button + Ctrl+J + auto-show on Run', async ({ page }) => {
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

  // Panel shown by default → empty-state hint visible.
  const hint = page.getByText(/Run a query .* to see results/)
  await expect(hint.first()).toBeVisible()

  // Click the toolbar toggle → panel hidden (hint gone).
  await page.getByTitle('Hide Result panel (Ctrl+J)').first().click()
  await expect(hint).toHaveCount(0)

  // Ctrl+J toggles it back on.
  await page.keyboard.press('Control+j')
  await expect(hint.first()).toBeVisible()

  // Hide again, then Run → the panel auto-reveals with results (hint replaced by grid).
  await page.getByTitle('Hide Result panel (Ctrl+J)').first().click()
  await expect(hint).toHaveCount(0)
  await page.locator('.cm-content').first().click()
  await page.keyboard.type('SELECT * FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(500)
  await expect(page.getByText(/Rows 1–3 of 3/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
