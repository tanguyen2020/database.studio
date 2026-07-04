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

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
