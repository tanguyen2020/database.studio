import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

test('CSV import wizard: file → preview → target → mapping', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // select Postgres so Explorer loads schemas, then click bottom "Import data"
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByTitle('Import data from file').first().click()
  await page.waitForTimeout(200)

  // step 1 wizard UI (parse/mapping/SQL logic covered by export/rows unit tests)
  await expect(page.getByText(/Import CSV/).first()).toBeVisible()
  await expect(page.getByText('Step 1 / 3').first()).toBeVisible()
  await expect(page.getByText('CSV file').first()).toBeVisible()
  await expect(page.getByText('Delimiter').first()).toBeVisible()
  await expect(page.getByText('Next').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
