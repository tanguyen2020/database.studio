import { expect, test, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { openApp } from './helpers'

// Export / Import Connections: pick connections, include their passwords sealed
// with a file password, then import the file — wrong password refused, every
// password carried, duplicates detected, names never clash.
// (The real file format + Argon2id/AES-GCM sealing is the backend's, covered by
// Rust tests in connections/transfer.rs + commands/transfer.rs.)

const FILE_PW = 'team-secret-1'

async function exportFile(page: Page, names: string[], withPasswords: boolean): Promise<string> {
  await page.getByRole('button', { name: 'Export connections' }).click()
  const dlg = page.getByRole('dialog', { name: 'Export connections' })
  await expect(dlg).toBeVisible()
  // everything is ticked to start with
  await expect(dlg.getByText(/^\d+ of \d+ selected$/)).toBeVisible()
  await dlg.getByRole('button', { name: 'Select none' }).click()
  await expect(dlg.getByText(/^0 of \d+ selected$/)).toBeVisible()
  for (const n of names) await dlg.getByRole('checkbox', { name: n, exact: true }).check()
  await expect(dlg.getByText(new RegExp(`^${names.length} of \\d+ selected$`))).toBeVisible()

  const include = dlg.getByRole('checkbox', { name: 'Include passwords' })
  await expect(include).toBeChecked()
  if (!withPasswords) await include.uncheck()
  const go = dlg.getByRole('button', { name: new RegExp(`^Export ${names.length} connection`) })
  if (withPasswords) {
    // no file password yet → cannot export
    await expect(go).toHaveAttribute('aria-disabled', 'true')
    await dlg.getByLabel('File password', { exact: true }).fill('short')
    await dlg.getByLabel('Repeat the file password').fill('short')
    await expect(dlg.getByText('Use at least 8 characters.')).toBeVisible()
    await dlg.getByLabel('File password', { exact: true }).fill(FILE_PW)
    await dlg.getByLabel('Repeat the file password').fill(FILE_PW + 'x')
    await expect(dlg.getByText('The two passwords do not match.')).toBeVisible()
    await dlg.getByLabel('Repeat the file password').fill(FILE_PW)
  }
  await expect(go).toHaveAttribute('aria-disabled', 'false')
  const [download] = await Promise.all([page.waitForEvent('download'), go.click()])
  expect(download.suggestedFilename()).toMatch(/^database-studio-connections-\d{4}-\d{2}-\d{2}\.json$/)
  const path = await download.path()
  await expect(dlg.getByText(`${names.length} connection${names.length === 1 ? '' : 's'} exported`)).toBeVisible()
  await dlg.getByRole('button', { name: 'Done' }).click()
  await expect(dlg).toBeHidden()
  return path!
}

async function openImport(page: Page, file: string) {
  await page.getByRole('button', { name: 'Import connections' }).click()
  const dlg = page.getByRole('dialog', { name: 'Import connections' })
  await expect(dlg).toBeVisible()
  await page.locator('input[aria-label="Connections file"]').setInputFiles(file)
  return dlg
}

test('export with passwords → import on "another computer" carries every password', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openApp(page)

  const file = await exportFile(page, ['Postgres', 'MySQL'], true)
  const text = readFileSync(file, 'utf8')
  const json = JSON.parse(text)
  expect(json.format).toBe('database-studio-connections')
  expect(json.count).toBe(2)
  expect(json.encrypted).toBeTruthy()
  expect(json.profiles).toBeUndefined()
  // nothing readable: not the host, not the user, not a password
  for (const leak of ['10.0.1.5', 'app_ro', 'demo-pw-', 'bastion.acme.io']) expect(text).not.toContain(leak)

  const dlg = await openImport(page, file)
  // sealed → asks for the file password; a wrong one is refused
  await expect(dlg.getByText(/This file carries passwords and is encrypted/)).toBeVisible()
  const pw = dlg.getByLabel('File password', { exact: true })
  await expect(pw).toBeFocused()
  await pw.fill('not-the-password')
  await dlg.getByRole('button', { name: 'Unlock' }).click()
  await expect(dlg.getByText(/Wrong password/)).toBeVisible()
  // backdrop click does not close a form dialog
  await page.mouse.click(8, 8)
  await expect(dlg).toBeVisible()
  await pw.fill(FILE_PW)
  await pw.press('Enter')

  // both are already here → kept by default, nothing to import yet
  await expect(dlg.getByText('Unlocked')).toBeVisible()
  const pgRow = dlg.locator('[data-import-row="Postgres"]')
  const myRow = dlg.locator('[data-import-row="MySQL"]')
  await expect(pgRow.getByText('Already here as “Postgres”')).toBeVisible()
  await expect(pgRow.locator('[data-pw="included"]')).toBeVisible()
  await expect(myRow.locator('[data-pw="included"]')).toBeVisible()
  // the SSH key is a path on the old computer — flagged
  await expect(pgRow.getByText(/Not on this computer/)).toBeVisible()
  await expect(pgRow.getByRole('button', { name: 'Keep mine' })).toHaveAttribute('aria-pressed', 'true')
  await expect(dlg.getByRole('button', { name: 'Import 0 connections' })).toHaveAttribute('aria-disabled', 'true')

  // add Postgres as a copy → renamed so names never clash
  await pgRow.getByRole('button', { name: 'Add copy' }).click()
  await expect(pgRow.getByText('Postgres (2)')).toBeVisible()
  await expect(pgRow.getByText('renamed from “Postgres”')).toBeVisible()
  // and update MySQL in place
  await myRow.getByRole('button', { name: 'Update' }).click()
  await dlg.getByRole('button', { name: 'Import 2 connections' }).click()
  await expect(dlg.getByText('2 connections imported')).toBeVisible()
  await expect(dlg.getByText(/1 added, 1 updated/)).toBeVisible()
  await expect(dlg.getByText(/2 came with their passwords/)).toBeVisible()

  // the passwords really travelled (demo saves `demo-pw-<old id>`)
  const secrets = await page.evaluate(() => (window as unknown as { __importedSecrets?: Record<string, string> }).__importedSecrets)
  expect(secrets).toEqual({ 'Postgres (2)': 'demo-pw-c1', MySQL: 'demo-pw-c2' })

  await dlg.getByRole('button', { name: 'Done' }).click()
  await expect(dlg).toBeHidden()
  await expect(page.getByText('Postgres (2)', { exact: true }).first()).toBeVisible()
  expect(errors).toEqual([])
})

test('a file without passwords imports directly and says which ones need a password', async ({ page }) => {
  await openApp(page)
  const file = await exportFile(page, ['MSSQL'], false)
  const text = readFileSync(file, 'utf8')
  const json = JSON.parse(text)
  expect(json.encrypted).toBeUndefined()
  expect(json.profiles[0].host).toBe('10.0.2.9')
  expect(json.profiles[0].id).toBe('')
  expect(text).not.toContain('demo-pw-')
  expect(text).not.toContain('has_password')

  const dlg = await openImport(page, file)
  // no file password asked — straight to the review
  await expect(dlg.getByText('File password')).toHaveCount(0)
  const row = dlg.locator('[data-import-row="MSSQL"]')
  await expect(row.locator('[data-pw="missing"]')).toHaveText('No password — asked when you connect')
  await row.getByRole('button', { name: 'Add copy' }).click()
  await dlg.getByRole('button', { name: 'Import 1 connection' }).click()
  await expect(dlg.getByText(/has no password yet/)).toBeVisible()
})

test('Export Connection… on a row starts with just that connection', async ({ page }) => {
  await openApp(page)
  await page.getByRole('button', { name: /MySQL localhost:3306/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Export Connection…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Export connections' })
  await expect(dlg.getByText(/^1 of \d+ selected$/)).toBeVisible()
  await expect(dlg.getByRole('checkbox', { name: 'MySQL', exact: true })).toBeChecked()
  await dlg.getByRole('button', { name: 'Cancel' }).click()
  await expect(dlg).toBeHidden()
})

test('a damaged or foreign file is explained, not imported', async ({ page }, info) => {
  await openApp(page)
  const bad = info.outputPath('bad.json')
  writeFileSync(bad, '{"format":"something-else","profiles":[]}')
  const dlg = await openImport(page, bad)
  await expect(dlg.getByText(/not a connections file/)).toBeVisible()
  await expect(dlg.getByRole('button', { name: 'Choose file…' })).toBeVisible()
})
