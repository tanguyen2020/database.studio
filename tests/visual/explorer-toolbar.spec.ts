import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// The Explorer bottom toolbar (New table / Query / Import / Generate scripts /
// Backup / Sessions / Users — 7 .xbtn buttons) is disabled until a relational
// schema/database node is selected, then acts on THAT schema. Non-relational
// connections never expose such a node → the whole toolbar stays disabled.
test('explorer bottom toolbar: enabled only when a relational schema is selected', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)

  // connection selected but no schema node picked → all 7 toolbar buttons disabled
  await expect(page.locator('.xbtn.off')).toHaveCount(7)
  await expect(page.getByTitle('Select a schema / database first').first()).toBeVisible()

  // pick the 'public' schema → toolbar enables and reflects the target
  await page.getByText('public', { exact: true }).first().click()
  await page.waitForTimeout(300)
  await expect(page.locator('.xbtn.off')).toHaveCount(0)
  await expect(page.getByTitle(/New table:/)).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('explorer bottom toolbar: disabled for a non-relational (Kafka) connection', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Events Kafka/ }).first().click()
  await page.waitForTimeout(500)

  // no relational schema node exists for Kafka → all 7 toolbar buttons stay disabled
  await expect(page.locator('.xbtn.off')).toHaveCount(7)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
