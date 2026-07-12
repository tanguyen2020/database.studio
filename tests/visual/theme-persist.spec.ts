import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// The chosen Light/Dark theme must survive an app restart (here: a full page
// reload, which — like relaunching the desktop app — re-runs boot from scratch).
test('theme choice persists across reload', async ({ page }) => {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })

  const html = page.locator('html')
  // default is dark
  await expect(html).toHaveClass(/(^|\s)dark(\s|$)/)

  // toggle to Light via the title-bar button
  await page.getByTitle('Toggle theme').first().click()
  await page.waitForTimeout(200)
  await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/)

  // reload = restart: boot must come back up in Light, with no dark flash
  await page.reload()
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/)
  // the title-bar label reflects the restored theme
  await expect(page.getByText('Light', { exact: true }).first()).toBeVisible()

  // toggle back to Dark and confirm that persists too
  await page.getByTitle('Toggle theme').first().click()
  await page.waitForTimeout(200)
  await page.reload()
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await expect(html).toHaveClass(/(^|\s)dark(\s|$)/)
})
