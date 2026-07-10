import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Truncate has per-engine variants (Postgres: plain / Cascade / Restart Identity) and
// always runs behind a confirm popup showing the exact statement (backdrop does not close).
test('truncate: Postgres variants + confirm popup', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('students', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(200)

  // Truncate is a submenu → open it and see the 3 Postgres variants
  await page.getByRole('menuitem', { name: 'Truncate', exact: true }).hover()
  await page.waitForTimeout(250)
  await expect(page.getByRole('menuitem', { name: 'Truncate Cascade', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Truncate Restart Identity', exact: true })).toBeVisible()

  // pick Cascade → confirm popup shows the exact statement
  await page.getByRole('menuitem', { name: 'Truncate Cascade', exact: true }).click()
  await page.waitForTimeout(200)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(/TRUNCATE TABLE .*CASCADE;/)).toBeVisible()

  // backdrop click must NOT close the confirm (rule chung); Cancel closes it
  await page.mouse.click(6, 6)
  await expect(dialog).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
