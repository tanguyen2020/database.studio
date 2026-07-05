import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// T12 — các nút trước đây là stub (toast/no-op) nay phải làm việc THẬT.
// (Convert + Split toolbar buttons removed in AUDIT-5 item 3 — split still works
// via the tab context menu, covered by split-view.spec.ts.)

async function boot(page: import('@playwright/test').Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
}

test('Set as Filter → opens Table Viewer with the column filter', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().click()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().click()
  await page.waitForTimeout(300)
  await page.getByText('students').first().click() // expand columns
  await page.waitForTimeout(300)
  await page.getByText('id', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('Set as Filter').first().click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('tab', { name: /students/ }).first()).toBeVisible()
  // filter builder mở sẵn với dòng filter (nút Clear xuất hiện)
  await expect(page.getByText('Clear', { exact: true }).first()).toBeVisible()
  expect(errors).toEqual([])
})

test('Chart SVG export → triggers a file download', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  // Chọn connection (set selectedId) rồi mở SQL tab MỚI — tab mới bind vào
  // selectedId, khác với tab orphan mặc định (connectionId=null → run() bỏ qua).
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(300)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(300)
  await page.locator('.cm-content').first().click()
  await page.keyboard.type('SELECT id, gpa FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  // result render → segmented toggle Grid/JSON/Single Row/Chart xuất hiện
  await expect(page.getByText('Single Row', { exact: true }).first()).toBeVisible({ timeout: 10_000 })
  await page.getByText('Chart', { exact: true }).first().click()
  await page.waitForTimeout(400)
  const dl = page.waitForEvent('download', { timeout: 8000 })
  await page.getByRole('button', { name: 'SVG', exact: true }).first().click()
  const download = await dl
  expect(download.suggestedFilename()).toContain('chart')
  expect(errors).toEqual([])
})
