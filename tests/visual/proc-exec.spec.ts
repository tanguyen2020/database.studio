import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// T28 — Execute a function/procedure: the dialog collects args by signature and
// opens the CALL/SELECT in a SQL tab. (Rename SQL + call builders are unit-tested
// in sql/routines.test.ts; rename runs against real engines in integration.)
test('execute routine: dialog by signature → SQL tab', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  await page.getByText('Functions', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  await page.getByText('add_one').first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('Execute…').first().click()
  await page.waitForTimeout(300)

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/Execute function add_one/)).toBeVisible()
  await dialog.locator('input').first().fill('41')
  await dialog.getByText('Open in SQL tab').click()
  await page.waitForTimeout(300)

  // a SQL tab opened; its editor holds the SELECT add_one(41)
  await expect(page.getByRole('tab', { name: /add_one/ }).first()).toBeVisible()
  await expect(page.locator('.cm-content').first()).toContainText('add_one')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
