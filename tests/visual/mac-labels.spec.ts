import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Shortcut labels follow the platform: ⌘ / ⇧ / ⌥ / ↩ on a Mac, "Ctrl+…" on
// Windows and Linux. `?mac=1` renders the Mac labels in the browser build (the
// desktop app detects the platform itself).

async function open(page: Page, query = '') {
  await blockRemoteFonts(page)
  await page.goto(APP_URL + query)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
}

async function shortcutsTable(page: Page) {
  await page.keyboard.press('Control+,')
  await page.getByRole('button', { name: 'Shortcuts', exact: true }).first().click()
  return page.getByRole('dialog')
}

test('Mac: shortcut labels use ⌘ ⇧ ⌥ ↩ and Ctrl+Tab stays ⌃', async ({ page }) => {
  await open(page, '?mac=1')
  await expect(page.getByTitle('New SQL tab (⌘T)').first()).toBeVisible()
  await expect(page.getByTitle(/^New connection \(⇧⌘N\)$/).first()).toBeAttached()

  const dlg = await shortcutsTable(page)
  for (const k of ['⌘↩', '⇧⌘F', '⇧⌘E', '⌘T / ⌘W', '⌃⇥', '⌘1..9', '⌘P', '⌥⌘G/J/R', '⌘,']) {
    await expect(dlg.getByText(k, { exact: true }), k).toBeVisible()
  }
  await expect(dlg.getByText(/Ctrl\+/)).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Query History is ⌘Y on a Mac (⌘H is the system's Hide)
  await page.keyboard.press('Control+p')
  await page.getByPlaceholder('Type a command or search…').fill('history')
  await expect(page.getByText('⌘Y', { exact: true }).first()).toBeVisible()
})

test('Windows / Linux: labels keep Ctrl+', async ({ page }) => {
  await open(page)
  await expect(page.getByTitle('New SQL tab (Ctrl+T)').first()).toBeVisible()
  const dlg = await shortcutsTable(page)
  await expect(dlg.getByText('Ctrl+Enter', { exact: true })).toBeVisible()
  await expect(dlg.getByText('Ctrl+Tab', { exact: true })).toBeVisible()
  await expect(dlg.getByText(/⌘/)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+p')
  await page.getByPlaceholder('Type a command or search…').fill('history')
  await expect(page.getByText('Ctrl+H', { exact: true }).first()).toBeVisible()
})
