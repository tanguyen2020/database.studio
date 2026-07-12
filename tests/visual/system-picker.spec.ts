import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// New Connection picker: a Close button in the footer dismisses it (same action
// as the × / Escape), without touching the card-grid selection flow.
test('new connection picker: footer Close button dismisses it', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByTitle('New connection').first().click()
  await page.waitForTimeout(150)

  const dialog = page.getByRole('dialog', { name: 'New Connection' })
  await expect(dialog).toBeVisible()
  // "Choose database type" is unique to the picker (the connection form has no such heading)
  await expect(page.getByText('Choose database type')).toBeVisible()

  // the footer Close button is present and dismisses the picker
  const close = dialog.getByRole('button', { name: 'Close', exact: true })
  await expect(close).toBeVisible()
  await close.click()
  await page.waitForTimeout(150)
  await expect(page.getByText('Choose database type')).toHaveCount(0)

  // reopening still works, and a card still opens the connection form (unaffected)
  await page.getByTitle('New connection').first().click()
  await page.waitForTimeout(150)
  await expect(page.getByText('Choose database type')).toBeVisible()
  await page.getByRole('dialog', { name: 'New Connection' }).getByText('PostgreSQL', { exact: true }).click()
  await page.waitForTimeout(200)
  // picker replaced by the connection form — its heading is gone
  await expect(page.getByText('Choose database type')).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
