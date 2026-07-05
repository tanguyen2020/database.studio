import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

test('ER diagram: nodes + edges + Mermaid/export toolbar', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // select Postgres → Explorer loads → right-click schema → View ER Diagram
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('View ER Diagram').first().click()
  await page.waitForTimeout(700)

  // ER tab + toolbar summary + Mermaid button
  await expect(page.getByRole('tab', { name: /ER · public/ }).first()).toBeVisible()
  await expect(page.getByText(/tables · .* relationships/).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mermaid' }).first()).toBeVisible()
  // table nodes rendered (SvelteFlow) — 'students' + 'enrollments'
  await expect(page.getByText('students').first()).toBeVisible()
  await expect(page.getByText('enrollments').first()).toBeVisible()

  // T20 — create relationship + Save to DB
  await page.getByText('+ Relationship').first().click()
  await page.waitForTimeout(200)
  const selects = page.locator('select')
  await selects.nth(0).selectOption('enrollments')
  await selects.nth(1).selectOption('id')
  await selects.nth(2).selectOption('students')
  await selects.nth(3).selectOption('id')
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/Save to DB/).first()).toBeVisible()
  await page.getByText(/Save to DB/).first().click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('tab', { name: /Add Relationships/ }).first()).toBeVisible()
  await expect(page.locator('.cm-content').first()).toContainText('ADD CONSTRAINT')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
