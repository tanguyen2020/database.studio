import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// T18 — Explorer depth: Show Definition, view column expansion,
// Object Properties panel. (Tree filter removed by later user request.)

test('explorer depth: Show Definition + properties + view columns', async ({ page }) => {
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

  // Functions → Show Definition on add_one
  await page.getByText('Functions', { exact: true }).first().dblclick()
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

  // View column expansion: expand Views → vw_active_students columns via chevron
  await page.getByText('Views', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  await page.getByRole('treeitem', { name: /vw_active_students/ }).first().getByRole('button').first().click()
  await page.waitForTimeout(300)
  await expect(page.getByText('first_name').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
