import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

test('settings: Ctrl+, opens, sections navigate, shortcuts listed', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // Ctrl+, opens Settings
  await page.keyboard.press('Control+,')
  await page.waitForTimeout(200)
  await expect(page.getByRole('dialog').getByText('Settings').first()).toBeVisible()
  await expect(page.getByText('Reset to defaults').first()).toBeVisible()

  // navigate to Editor section → tab size control
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  await page.waitForTimeout(150)
  await expect(page.getByText('Word wrap').first()).toBeVisible()

  // Shortcuts section lists key bindings
  await page.getByRole('button', { name: 'Shortcuts', exact: true }).click()
  await page.waitForTimeout(150)
  await expect(page.getByText('Command palette').first()).toBeVisible()

  // Escape closes
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  await expect(page.getByRole('dialog')).toBeHidden()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
