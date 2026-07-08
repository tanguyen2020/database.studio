import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// T15 — Generate Scripts: whole-schema dump (structure). The "Generate" button
// saves a .sql file (native Save dialog in the desktop app; a browser download
// here) with CREATE TABLE + FK ALTERs, showing a progress bar through completion.

test('Generate Scripts (structure) → saves a .sql file with CREATE TABLE + FK ALTER', async ({ page }) => {
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

  const dialog = page.getByRole('dialog').first()
  await expect(dialog.getByText(/Generate Scripts ·/)).toBeVisible()
  await expect(dialog.getByText('Structure only')).toBeVisible()
  await expect(dialog.getByText('Data only')).toBeVisible()
  await expect(dialog.getByText(/Objects \(/)).toBeVisible()

  // item 3 — grouped by object type (Tables/Views/Stored Procedures/Functions/…)
  await expect(dialog.getByText(/Tables \(/)).toBeVisible()
  await expect(dialog.getByText(/Views \(/)).toBeVisible()
  await expect(dialog.getByText(/Stored Procedures \(/)).toBeVisible()
  await expect(dialog.getByText(/Functions \(/)).toBeVisible()

  // "Generate" (renamed from "Generate → SQL tab") saves a file → browser download
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Generate', exact: true }).click(),
  ])
  expect(dl.suggestedFilename()).toBe('scripts_public.sql')

  // the generated file contains dependency-ordered DDL
  const fs = await import('node:fs')
  const path = await dl.path()
  const content = fs.readFileSync(path, 'utf8')
  expect(content).toContain('CREATE TABLE')
  expect(content).toContain('ADD CONSTRAINT')

  // progress overlay reached completion
  await expect(page.getByText('Generate complete').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
