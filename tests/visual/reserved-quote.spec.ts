import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

async function openSqlTab(page: import('@playwright/test').Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(600)
}

// A column/table whose name is a reserved word (here `order`) must be inserted
// QUOTED by autocomplete, or the query/JOIN is a syntax error. Postgres → "order".
// And a single Tab/Enter must accept the highlighted suggestion (no arrow needed).
test('Tab accepts and quotes a reserved-word column', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openSqlTab(page)

  const content = page.locator('.view-lines').first()
  await content.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  // reference the table via an alias so the `alias.` column completion kicks in
  await page.keyboard.type('SELECT * FROM students s WHERE s.or')
  await page.waitForTimeout(900)

  await expect(page.locator('.suggest-widget.visible')).toBeVisible({ timeout: 3000 })
  await page.keyboard.press('Tab') // single Tab accepts the highlighted column
  await page.waitForTimeout(200)

  await expect(content).toContainText('s."order"')
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('Enter accepts the column, and inserts a newline when no popup is open', async ({ page }) => {
  await openSqlTab(page)
  const content = page.locator('.view-lines').first()
  await content.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type('SELECT * FROM students s WHERE s.or')
  await page.waitForTimeout(900)
  await expect(page.locator('.suggest-widget.visible')).toBeVisible({ timeout: 3000 })
  await page.keyboard.press('Enter') // accepts the column
  await page.waitForTimeout(200)
  await expect(content).toContainText('s."order"')

  // with no completion popup open, Enter is a normal newline
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  await page.keyboard.type(' = 1')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  await page.keyboard.press('Enter')
  await page.keyboard.type('LIMIT 10')
  await page.waitForTimeout(150)
  await expect(content).toContainText('LIMIT 10')
})
