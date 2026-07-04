import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// T14 — Export wizard: table mode (from Explorer context) + result custom mode.

async function boot(page: import('@playwright/test').Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
}

test('Table Export wizard: format/columns/WHERE/limit/filename → download', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().click()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().click()
  await page.waitForTimeout(300)
  await page.getByText('students').first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('Export Data…').first().click()
  await page.waitForTimeout(300)

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Export students')).toBeVisible()
  await expect(dialog.getByText(/Columns \(/)).toBeVisible()
  await expect(dialog.getByText('WHERE (optional)')).toBeVisible()
  await expect(dialog.getByText('Filename')).toBeVisible()

  // run export → CSV file download
  const dl = page.waitForEvent('download', { timeout: 8000 })
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  const download = await dl
  expect(download.suggestedFilename()).toContain('students')
  await expect(dialog.getByText(/exported \d+ rows/)).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('Result custom Export: run query → Export ▾ → Custom → download', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(300)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(300)
  await page.locator('.cm-content').first().click()
  await page.keyboard.type('SELECT id, gpa FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await expect(page.getByText('Single Row', { exact: true }).first()).toBeVisible({ timeout: 10_000 })

  await page.getByText('Export ▾').first().click()
  await page.waitForTimeout(150)
  await page.getByText(/Custom…/).first().click()
  await page.waitForTimeout(300)

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Export result')).toBeVisible()
  await expect(dialog.getByText(/Columns \(/)).toBeVisible()
  // result mode has no WHERE (rows already materialized)
  await expect(dialog.getByText('WHERE (optional)')).toHaveCount(0)

  const dl = page.waitForEvent('download', { timeout: 8000 })
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  const download = await dl
  expect(download.suggestedFilename()).toContain('result')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
