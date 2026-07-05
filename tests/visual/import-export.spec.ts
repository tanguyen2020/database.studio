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

test('CSV import full flow: file → mapping → Options → batched import (T13)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByTitle('Import data from file').first().click()
  await page.waitForTimeout(200)

  // step 1: upload CSV whose headers match demo students columns (id, first_name)
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'students.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('id,first_name\n1,An\n2,Binh\n3,Chi'),
  })
  await page.waitForTimeout(200)
  // the chosen file name shows in the read-only text field next to the button
  await expect(dialog.locator('input[readonly]').first()).toHaveValue('students.csv')
  await expect(page.getByText(/Preview \(3 rows\)/).first()).toBeVisible()
  await dialog.locator('select').last().selectOption('students')
  await page.getByText('Next', { exact: true }).first().click()

  // step 2: mapping auto-filled → Next
  await expect(page.getByText(/Map columns/).first()).toBeVisible()
  await page.getByText('Next', { exact: true }).first().click()

  // step 3: Options step — new controls
  await expect(page.getByText('Options', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/Batch size/).first()).toBeVisible()
  await expect(page.getByText('On conflict').first()).toBeVisible()

  // run batched import → progress + success result
  await page.getByText(/^Import 3 rows$/).first().click()
  await expect(page.getByText(/rows inserted/).first()).toBeVisible({ timeout: 8000 })

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
