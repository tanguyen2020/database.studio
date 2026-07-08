import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Unify Collation… (MySQL/MariaDB): the database context menu opens a dialog
// that audits information_schema, lists a target collation, shows the affected
// tables + a CONVERT-TO preview (procedures/views/triggers untouched), and can
// open the migration in a SQL tab. Statement generation is unit-tested in
// sql/collation.test.ts; the DDL is proven on a real engine in the integration
// suite — this spec only exercises the UI wiring.
test('unify collation dialog: audit + preview + open in SQL tab', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // select the MySQL demo connection (by its unique host) → its database node renders
  await page.getByRole('button', { name: /localhost:3306/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().click({ button: 'right' })
  await page.getByText('Unify Collation…').first().click()
  await page.waitForTimeout(300)

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/Unify collation · public/)).toBeVisible()
  // demo audit surfaces a general_ci table off-target from the 0900 default
  await expect(dialog.getByText(/table\(s\) will be converted/).first()).toBeVisible()
  await expect(dialog.getByText(/audit_log/).first()).toBeVisible()
  await expect(dialog.getByText(/CONVERT TO CHARACTER SET utf8mb4/)).toBeVisible()
  await expect(dialog.getByText(/procedures\/views\/triggers untouched/)).toBeVisible()

  // backdrop click must NOT close the dialog (repo-wide rule)
  await page.mouse.click(8, 8)
  await expect(dialog.getByText(/Unify collation · public/)).toBeVisible()

  // open the migration in a SQL tab
  await dialog.getByText('Open in SQL tab').click()
  await page.waitForTimeout(300)
  await expect(page.getByText(/Unify collation · public/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
