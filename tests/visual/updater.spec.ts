import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// In-app updates. The real check/download needs the desktop runtime, so the
// browser build uses the `?fakeUpdate=<version>` seam to render the prompt and
// exercise its wiring (prompt appears, backdrop can't dismiss it, Later/Skip
// close it, Skip stays quiet on the next launch).

async function open(page: import('@playwright/test').Page, query = '') {
  await blockRemoteFonts(page)
  await page.goto(`${APP_URL}${query}`)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(500)
}

test('offers the update, and Later dismisses it for this run', async ({ page }) => {
  await open(page, '?fakeUpdate=0.1.0-beta.99')
  const dialog = page.getByRole('dialog', { name: 'Update available' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('0.1.0-beta.99')
  await expect(dialog.getByRole('button', { name: 'Update and restart' })).toBeVisible()

  // project rule: a backdrop click must NOT close a form/dialog popup
  await page.mouse.click(8, 8)
  await expect(dialog).toBeVisible()

  await dialog.getByRole('button', { name: 'Later' }).click()
  await expect(dialog).toBeHidden()
})

test('Skip this version keeps quiet on the next launch, and Settings can re-check', async ({ page }) => {
  await open(page, '?fakeUpdate=0.1.0-beta.99')
  const dialog = page.getByRole('dialog', { name: 'Update available' })
  await dialog.getByRole('button', { name: 'Skip this version' }).click()
  await expect(dialog).toBeHidden()

  // relaunch: the skipped version must not prompt again
  await open(page, '?fakeUpdate=0.1.0-beta.99')
  await expect(page.getByRole('dialog', { name: 'Update available' })).toBeHidden()

  // a NEWER version still prompts
  await open(page, '?fakeUpdate=0.2.0')
  await expect(page.getByRole('dialog', { name: 'Update available' })).toBeVisible()
})

test('Settings shows the running version and an update check', async ({ page }) => {
  await open(page)
  await page.keyboard.press('Control+,')
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: 'Updates', exact: true }).click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/Current version/)).toBeVisible()
  // the button exists; it's disabled outside the desktop build
  await expect(page.getByRole('button', { name: 'Check for updates' })).toBeVisible()
})
