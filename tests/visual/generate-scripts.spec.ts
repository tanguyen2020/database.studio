import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// T15 — Generate Scripts: whole-schema dump (structure) → SQL tab with CREATE
// TABLE + FK ALTERs in dependency order.

test('Generate Scripts (structure) → SQL tab with CREATE TABLE + FK ALTER', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByTitle('Generate scripts (dump schema)').first().click()
  await page.waitForTimeout(400)

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/Generate Scripts ·/)).toBeVisible()
  await expect(dialog.getByText('Structure only')).toBeVisible()
  await expect(dialog.getByText('Data only')).toBeVisible()
  await expect(dialog.getByText(/Objects \(/)).toBeVisible()

  // item 3 — grouped by object type (Tables/Views/Stored Procedures/Functions/…)
  await expect(dialog.getByText(/Tables \(/)).toBeVisible()
  await expect(dialog.getByText(/Views \(/)).toBeVisible()
  await expect(dialog.getByText(/Stored Procedures \(/)).toBeVisible()
  await expect(dialog.getByText(/Functions \(/)).toBeVisible()

  await dialog.getByRole('button', { name: /Generate/ }).click()
  await page.waitForTimeout(600)

  // a "Scripts · public" tab opened with generated DDL
  await expect(page.getByRole('tab', { name: /Scripts ·/ }).first()).toBeVisible()
  const editor = page.locator('.cm-content').first()
  await expect(editor).toContainText('CREATE TABLE')
  await expect(editor).toContainText('ADD CONSTRAINT')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
