import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Keyboard shortcuts for the Connections sidebar: focus the list, move the
// selection, open/close a connection, filter, and create a new one.
test('connections: keyboard navigation + shortcuts', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)

  // Ctrl+Shift+B → the list takes focus and selects a connection.
  // (B, not E: Ctrl+Shift+E is the editor's Explain binding.)
  await page.keyboard.press('Control+Shift+B')
  await page.waitForTimeout(200)
  const focusedLabel = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))
  expect(focusedLabel).toBe('Connections')
  const selected = page.locator('.conn-row.selected')
  await expect(selected).toHaveCount(1)
  const first = (await selected.textContent())?.trim()

  // ↓ moves the selection to the next connection, ↑ moves back.
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(150)
  const second = (await page.locator('.conn-row.selected').textContent())?.trim()
  expect(second).not.toBe(first)
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(150)
  expect((await page.locator('.conn-row.selected').textContent())?.trim()).toBe(first)

  // ← collapses the selected connection's group (its rows disappear), → expands.
  const rowsBefore = await page.locator('.conn-row').count()
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(150)
  expect(await page.locator('.conn-row').count()).toBeLessThan(rowsBefore)
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(150)
  expect(await page.locator('.conn-row').count()).toBe(rowsBefore)

  // Ctrl+Shift+K opens the filter box and focuses it.
  await page.keyboard.press('Control+Shift+K')
  await page.waitForTimeout(200)
  const filter = page.getByPlaceholder('Filter by name, host, database…')
  await expect(filter).toBeVisible()
  await expect(filter).toBeFocused()
  await page.keyboard.press('Escape')

  // Ctrl+Shift+N opens the system picker (new connection).
  await page.keyboard.press('Control+Shift+N')
  await page.waitForTimeout(250)
  await expect(page.locator('.picker-card').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Ctrl+Shift+O connects the selected connection (and disconnects it again).
test('connections: Ctrl+Shift+O connects / disconnects the selection', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)

  // Pick a connection that starts disconnected in the demo fixture.
  const row = page.locator('.conn-row').filter({ hasText: '10.0.2.9' }).first()
  await row.click()
  await page.waitForTimeout(150)
  await expect(row.locator('[title="Disconnected"]')).toHaveCount(1)

  await page.keyboard.press('Control+Shift+O')
  await page.waitForTimeout(500)
  await expect(row.locator('[title^="Connected"]')).toHaveCount(1)

  await page.keyboard.press('Control+Shift+O')
  await page.waitForTimeout(400)
  await expect(row.locator('[title="Disconnected"]')).toHaveCount(1)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// SQLite is file-based: the path field must offer a visible Browse button (the
// double-click affordance alone was undiscoverable).
test('connection form: SQLite path has a Browse button', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByTitle('New connection').first().click()
  await page.waitForTimeout(200)
  await page.locator('.picker-card').filter({ hasText: 'SQLite' }).first().click()
  await page.waitForTimeout(300)

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Host', { exact: true })).toBeVisible()
  const browse = dialog.getByRole('button', { name: 'Browse…' }).first()
  await expect(browse).toBeVisible()
  await expect(browse).toHaveAttribute('title', 'Choose a SQLite database file')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
