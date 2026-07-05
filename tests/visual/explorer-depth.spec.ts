import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// T18 — Explorer depth: Show Definition, view column expansion, tree filter,
// Object Properties panel.

test('explorer depth: Show Definition + properties + view columns + filter', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)

  // tree filter input present (Ctrl+F target)
  await expect(page.getByPlaceholder(/Filter tree/).first()).toBeVisible()

  await page.getByText('public', { exact: true }).first().click()
  await page.waitForTimeout(300)

  // Functions → Show Definition on add_one
  await page.getByText('Functions', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await page.getByText(/add_one/).first().click() // select → Properties panel
  await page.waitForTimeout(150)
  await expect(page.getByText('Properties', { exact: true }).first()).toBeVisible()

  await page.getByText(/add_one/).first().click({ button: 'right' })
  await page.waitForTimeout(150)
  await page.getByText('Show Definition').first().click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('tab', { name: /add_one · definition/ }).first()).toBeVisible()
  await expect(page.locator('.cm-content').first()).toContainText('CREATE')

  // View column expansion: expand Views → vw_active_students → columns appear
  await page.getByText('Views', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await page.getByText('vw_active_students').first().click()
  await page.waitForTimeout(300)
  await expect(page.getByText('first_name').first()).toBeVisible()

  // tree filter narrows the tree
  await page.getByPlaceholder(/Filter tree/).first().fill('add_one')
  await page.waitForTimeout(200)
  await expect(page.getByText(/add_one/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
