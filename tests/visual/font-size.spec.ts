import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Title-bar "Font" button (right of Light/Dark) sets a global UI scale that applies
// to the whole app via document zoom, and persists.
test('title bar: font-size menu scales the whole app', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // open the font menu (next to the theme toggle) — options identified by % (unique)
  await page.getByRole('button', { name: 'Font' }).click()
  await expect(page.getByRole('menuitemradio', { name: /100%/ })).toBeVisible()
  await expect(page.getByRole('menuitemradio', { name: /110%/ })).toBeVisible()

  // pick Large (110%) → applies document zoom
  await page.getByRole('menuitemradio', { name: /110%/ }).click()
  await page.waitForTimeout(150)
  expect(await page.evaluate(() => document.documentElement.style.zoom)).toBe('1.1')

  // reopen → the active option is checked
  await page.getByRole('button', { name: 'Font' }).click()
  await expect(page.getByRole('menuitemradio', { name: /110%/ })).toHaveAttribute('aria-checked', 'true')

  // reset to Default (100%) so state is clean
  await page.getByRole('menuitemradio', { name: /100%/ }).click()
  expect(await page.evaluate(() => document.documentElement.style.zoom)).toBe('1')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
