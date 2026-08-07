import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// DELETE without WHERE / TRUNCATE in the query editor must pop an in-app
// confirm before running (all relational systems). Enter/Tab accept-completion
// is exercised by CodeMirror; here we cover the destructive-statement guard.

async function boot(page: import('@playwright/test').Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(300)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(300)
}

async function typeAndRun(page: import('@playwright/test').Page, sql: string) {
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(sql)
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(200)
}

test('DELETE without WHERE prompts; Cancel aborts, Run anyway executes', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  await typeAndRun(page, 'DELETE FROM students')
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Delete all rows without a filter?')).toBeVisible()
  await expect(dialog.getByText(/DELETE \(no WHERE\)/).first()).toBeVisible()

  // rule: Cancel is the DEFAULT focus when a destructive confirm opens
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()

  // backdrop click must NOT close the confirm
  await page.mouse.click(6, 6)
  await expect(dialog.getByText('Delete all rows without a filter?')).toBeVisible()

  // Cancel → dialog closes, nothing ran
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // Run anyway → confirm closes and the statement executes
  await typeAndRun(page, 'DELETE FROM students')
  await page.getByRole('dialog').getByRole('button', { name: 'Run anyway' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('DELETE with WHERE runs without a prompt', async ({ page }) => {
  await boot(page)
  await typeAndRun(page, 'DELETE FROM students WHERE id = 1')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('TRUNCATE prompts for confirmation', async ({ page }) => {
  await boot(page)
  await typeAndRun(page, 'TRUNCATE students')
  await expect(page.getByRole('dialog').getByText('Delete all rows without a filter?')).toBeVisible()
  await expect(page.getByRole('dialog').getByText(/TRUNCATE/).first()).toBeVisible()
})
