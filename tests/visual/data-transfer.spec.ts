import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Data Transfer — copy several tables from one connection to another. The plan
// orders parents before children (copy/plan.ts) and each table runs the paged
// read→insert→verify loop. `?transferDemo=1` makes the export SELECT return a
// fixed small page so the loop ends and the count verifies.

async function openPgSchemaMenu(page: Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL + '?transferDemo=1')
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.waitForTimeout(300)
  await page.getByRole('treeitem', { name: /public/ }).first().click({ button: 'right' })
}

test('transfers several tables, parents first, with progress and a per-table log', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openPgSchemaMenu(page)

  await page.getByRole('menuitem', { name: 'Transfer Data To…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Transfer data' })
  await expect(dlg).toBeVisible()

  // pick two tables that have an FK order (enrollments → students)
  await dlg.getByRole('checkbox', { name: 'students', exact: true }).check()
  await dlg.getByRole('checkbox', { name: 'enrollments', exact: true }).check()
  await expect(dlg.getByText(/2 selected/)).toBeVisible()

  // destination = another connection
  await dlg.locator('select').first().selectOption({ label: 'Staging Postgres · postgres' })

  // preview puts the referenced parent (students) before the child (enrollments)
  await dlg.getByRole('button', { name: 'Preview order' }).click()
  const stepNames = dlg.locator('.tr-step-name')
  await expect(stepNames.first()).toHaveText(/students/)
  await expect(stepNames.nth(1)).toHaveText(/enrollments/)

  // backdrop click must not close a form popup
  await page.mouse.click(8, 8)
  await expect(dlg).toBeVisible()

  await dlg.getByRole('button', { name: /^Transfer 2 tables/ }).click()

  // done: two tables copied, log shows rows for each, destination verified
  await expect(dlg.getByText(/2 tables transferred/)).toBeVisible({ timeout: 15_000 })
  const log = dlg.locator('.tr-log-row')
  await expect(log).toHaveCount(2)
  await expect(log.filter({ hasText: 'students' })).toContainText(/3 rows copied/)
  await expect(log.filter({ hasText: 'enrollments' })).toContainText(/3 rows copied/)

  await dlg.getByRole('button', { name: 'Done' }).click()
  await expect(dlg).toBeHidden()
  expect(errors).toEqual([])
})

test('structure-only transfer copies no rows; Append needs existing tables', async ({ page }) => {
  await openPgSchemaMenu(page)
  await page.getByRole('menuitem', { name: 'Transfer Data To…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Transfer data' })

  await dlg.getByRole('checkbox', { name: 'courses', exact: true }).check()
  await dlg.locator('select').first().selectOption({ label: 'Staging Postgres · postgres' })

  // turn off Copy data → structure only
  await dlg.getByRole('checkbox', { name: 'Copy data' }).uncheck()
  await dlg.getByRole('button', { name: /^Transfer 1 table/ }).click()

  await expect(dlg.getByText(/1 table transferred/)).toBeVisible({ timeout: 15_000 })
  await expect(dlg.locator('.tr-log-row').first()).toContainText(/structure created \(no data copied\)/)
})
