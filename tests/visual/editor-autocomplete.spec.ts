import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// The query editor's autocomplete must suggest the tables of the ACTIVE
// database — including after the database is switched in the toolbar dropdown
// (suggestions repoint to the picked database's tables).

async function openSqlTab(page: import('@playwright/test').Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(600)
}

async function completionsFor(page: import('@playwright/test').Page, text: string) {
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(text)
  await page.waitForTimeout(500)
  const tip = page.locator('.cm-tooltip-autocomplete')
  await expect(tip).toBeVisible({ timeout: 3000 })
  return tip.innerText()
}

test('suggests tables of the connected database', async ({ page }) => {
  await openSqlTab(page)
  const list = await completionsFor(page, 'SELECT * FROM stu')
  expect(list).toContain('students')
  // the suggestion is explicit: the table's schema/database shows as a qualifier,
  // right-aligned to the edge of a comfortably wide popup.
  const row = page.locator('.cm-tooltip-autocomplete li').first()
  const detail = row.locator('.cm-completionDetail')
  await expect(detail).toHaveText('public')
  const labelBox = await row.locator('.cm-completionLabel').boundingBox()
  const detailBox = await detail.boundingBox()
  // the qualifier sits well to the right of the label (a real gap, not adjacent)
  expect(detailBox!.x).toBeGreaterThan(labelBox!.x + labelBox!.width + 40)
})

test('suggests tables after switching the database', async ({ page }) => {
  await openSqlTab(page)
  // switch to another database via the searchable combobox: type to filter, pick
  const dbInput = page.getByTitle('Database', { exact: true })
  await dbInput.click()
  await page.waitForTimeout(200)
  await dbInput.fill('analy')
  await page.waitForTimeout(200)
  await page.getByRole('option', { name: 'analytics' }).first().click()
  await page.waitForTimeout(900)
  const list = await completionsFor(page, 'SELECT * FROM stu')
  expect(list).toContain('students')
})
