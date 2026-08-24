import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Audit fixes: #3 connection row hover/selected, #4 table 3-mode Generate Scripts.

async function boot(page: import('@playwright/test').Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
}

test('#3 connection row: selected class + hover style (no inline trap)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(300)
  await openDatabaseNode(page)
  // selected → dòng có class .conn-row.selected (thanh accent) — không dựa inline bg
  await expect(page.locator('.conn-row.selected').first()).toBeVisible()

  // hover 1 dòng chưa selected → background đổi (không còn trong suốt)
  const other = page.locator('.conn-row:not(.selected)').first()
  await other.hover()
  const bg = await other.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(bg).not.toBe('rgba(0, 0, 0, 0)') // != transparent → hover có hiệu ứng
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('#4 table context menu: Generate Scripts → Structure and Data', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('students').first().click({ button: 'right' })
  await page.waitForTimeout(200)

  // submenu Generate Scripts → 3 tùy chọn
  await page.getByText('Generate Scripts', { exact: true }).first().hover()
  await page.waitForTimeout(200)
  await expect(page.getByText('Structure Only')).toBeVisible()
  await expect(page.getByText('Data Only')).toBeVisible()
  await page.getByText('Structure and Data').first().click()
  await page.waitForTimeout(400)

  await expect(page.getByRole('tab', { name: /students · scripts/ }).first()).toBeVisible()
  const editor = page.locator('.view-lines').first()
  await expect(editor).toContainText('CREATE TABLE')
  await expect(editor).toContainText('INSERT INTO')
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
