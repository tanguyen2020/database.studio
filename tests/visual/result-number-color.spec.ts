import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// ResultGrid tints number-type columns (int/smallint/bigint/decimal/numeric/
// float/double/real) for relational engines, using --syntax-number. The demo
// SELECT returns id (int4), first_name (varchar), gpa (numeric) — so id/gpa are
// tinted while first_name keeps the default text color.
test('result grid: numeric columns are color-tinted (relational)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(200)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(200)

  await page.locator('.cm-content').first().click()
  await page.keyboard.type('SELECT * FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(500)
  await expect(page.getByText(/Rows 1–3 of 3/).first()).toBeVisible()

  const colorOf = (t: string) =>
    page.getByText(t, { exact: true }).first().evaluate((el) => getComputedStyle(el).color)

  const gpaColor = await colorOf('3.9') // numeric column value
  const nameColor = await colorOf('An') // text column value

  // numeric cell is tinted differently from a plain text cell
  expect(gpaColor).not.toBe(nameColor)
  // and it resolves to the --syntax-number token (dark theme default = #d19a66)
  expect(gpaColor).toBe('rgb(209, 154, 102)')

  // numeric column values are right-aligned (DataGrip-style); text stays left
  const justifyOf = (t: string) =>
    page.getByText(t, { exact: true }).first().locator('..').evaluate((el) => getComputedStyle(el).justifyContent)
  expect(await justifyOf('3.9')).toBe('flex-end')
  expect(await justifyOf('An')).not.toBe('flex-end')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
