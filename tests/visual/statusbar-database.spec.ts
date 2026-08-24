import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// The bottom status bar's object qualifier must show the DATABASE a statement ran
// against for MySQL (where a schema IS a database) — the connection's DB
// (`library_db` in the demo), not the cached default schema (`public`).
test('status bar: MySQL shows the run database, not the default schema', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // open a query console bound to the MySQL connection (unique host:port)
  await page.getByText('localhost:3306', { exact: false }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('New Query Console', { exact: true }).first().click()
  await page.waitForTimeout(700)

  await page.locator('.view-lines').first().click()
  await page.keyboard.type('SELECT * FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(600)

  // status bar object qualifier reflects the MySQL database (library_db), not "public"
  await expect(page.getByText('library_db', { exact: false }).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
