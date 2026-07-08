import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Result Grid Export dropdown: each format writes a correctly-named file, shows a
// progress overlay through completion, and highlights blue on hover.
test('result export: CSV downloads with a progress overlay + blue hover', async ({ page }) => {
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
  await page.locator('.cm-content').first().click()
  await page.keyboard.type('SELECT * FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(500)

  // open the Export dropdown
  await page.getByText('Export ▾').first().click()
  await page.waitForTimeout(150)
  const csvItem = page.locator('.exp-item', { hasText: 'CSV' }).first()
  await expect(csvItem).toBeVisible()

  // blue hover highlight
  await csvItem.hover()
  await page.waitForTimeout(100)
  const bg = await csvItem.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(bg).not.toBe('rgba(0, 0, 0, 0)') // not transparent → the blue highlight applied

  // clicking CSV triggers a download named result.csv…
  const [dl] = await Promise.all([page.waitForEvent('download'), csvItem.click()])
  expect(dl.suggestedFilename()).toBe('result.csv')

  // …and the progress overlay reaches completion
  await expect(page.getByText('Export complete').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
