import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode, previewText } from './helpers'

// Data Compare — row-level diff of two tables. `?compareDemo=1` makes the keyed
// SELECT return drifting rows on each side: source (c1) has ids 1/2/3, target
// (c7) has 1 (same), 2 (one column changed), 4 (target-only) → every bucket.
test('compares two tables, shows the four buckets, and builds a sync script', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL + '?compareDemo=1')
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  await page.getByText('students').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Compare Data…' }).click()
  await page.waitForTimeout(300)

  const dc = page.locator('.dc')
  await expect(dc).toBeVisible()

  // source is preselected from the Explorer
  await expect(dc.getByRole('combobox', { name: 'Source table' })).toHaveValue('students')

  // target = the other connection, same schema + table
  const tgt = dc.locator('.dc-side').nth(1)
  await tgt.getByRole('combobox', { name: 'Target connection' }).selectOption({ label: 'Staging Postgres · postgres' })
  await tgt.getByRole('combobox', { name: 'Target schema' }).selectOption('public')
  await tgt.getByRole('combobox', { name: 'Target table' }).selectOption('students')
  await page.waitForTimeout(300)

  // key column defaulted to the PK
  await expect(dc.getByRole('checkbox', { name: 'id', exact: true })).toBeChecked()

  await dc.getByRole('button', { name: 'Compare' }).click()
  await page.waitForTimeout(400)

  // four buckets: 1 insert, 1 update, 1 delete, 1 same
  const cards = dc.locator('.dc-card')
  await expect(cards.nth(0)).toContainText('Only in source')
  await expect(cards.nth(0).locator('.dc-n')).toHaveText('1')
  await expect(cards.nth(1).locator('.dc-n')).toHaveText('1') // Different
  await expect(cards.nth(2).locator('.dc-n')).toHaveText('1') // Only in target
  await expect(cards.nth(3).locator('.dc-n')).toHaveText('1') // Same

  // the different row shows the changed column, source vs target
  await cards.nth(1).click()
  const row = dc.locator('.dc-row').first()
  await row.getByRole('button').click()
  await expect(dc.locator('.dc-diff')).toContainText('first_name')
  await expect(dc.locator('.dc-sv')).toContainText('Bob')
  await expect(dc.locator('.dc-tv')).toContainText('Bobby')

  // sync script — INSERT + UPDATE on by default, DELETE off
  await dc.getByRole('button', { name: 'Sync script' }).click()
  await page.waitForTimeout(200)
  let sql = await previewText(page, 'Sync script')
  expect(sql).toContain('INSERT INTO')
  expect(sql).toContain('UPDATE')
  expect(sql).not.toContain('DELETE')

  // enable DELETE → the target-only row is removed
  await dc.getByRole('checkbox', { name: /^DELETE/ }).check()
  await page.waitForTimeout(200)
  sql = await previewText(page, 'Sync script')
  expect(sql).toContain('DELETE FROM')

  // Apply → DELETE is destructive so the table name must be typed
  await dc.getByRole('button', { name: /^Apply to target/ }).click()
  const dlg = page.getByRole('dialog', { name: 'Apply sync' })
  await expect(dlg).toBeVisible()
  await expect(dlg.getByRole('button', { name: 'Apply' })).toBeDisabled()
  // backdrop click must not close it
  await page.mouse.click(8, 8)
  await expect(dlg).toBeVisible()
  await dlg.getByRole('textbox', { name: 'Confirm table name' }).fill('students')
  await dlg.getByRole('button', { name: 'Apply' }).click()
  await page.waitForTimeout(400)
  await expect(dlg).toBeHidden()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
