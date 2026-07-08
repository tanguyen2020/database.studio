import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// When a database node is selected in the ObjectExplorer, the sidebar "New query
// console" button opens a Query Editor bound to THAT database — its Database
// dropdown pre-selects the picked database (and runs against it).
test('new query console binds to the selected database', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // select the Postgres connection and let the tree (incl. other databases) load
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(700)

  // pick a NON-current database node (attaches a sub-connection on click)
  await page.getByText('analytics', { exact: true }).first().click()
  await page.waitForTimeout(800) // wait for attach_database to resolve

  // open a new query console from the sidebar toolbar
  await page.getByTitle('New query console').click()
  await page.waitForTimeout(600)

  // the Query Editor's Database dropdown pre-selects the picked database
  const dbDropdown = page.getByTitle('Database', { exact: true })
  await expect(dbDropdown).toBeVisible()
  await expect(dbDropdown).toHaveValue('analytics')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
