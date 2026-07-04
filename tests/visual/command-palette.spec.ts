import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

test('command palette: Ctrl+P opens, fuzzy filters, Enter runs', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // Ctrl+P opens the palette
  await page.keyboard.press('Control+p')
  await page.waitForTimeout(200)
  const input = page.getByPlaceholder('Type a command or search…')
  await expect(input).toBeVisible()

  // fuzzy search "history" → the Query History action surfaces
  await input.fill('history')
  await page.waitForTimeout(150)
  await expect(page.getByText('Open Query History').first()).toBeVisible()

  // Enter runs top result → History tab opens
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  await expect(input).toBeHidden()
  await expect(page.getByRole('tab', { name: /Query History/ }).first()).toBeVisible()

  // reopen + Escape closes
  await page.keyboard.press('Control+p')
  await page.waitForTimeout(150)
  await expect(page.getByPlaceholder('Type a command or search…')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  await expect(page.getByPlaceholder('Type a command or search…')).toBeHidden()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
