import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Phase C5 — Create opens an editable CQL template; Drop runs behind an in-app
// confirm (backdrop does not close it).
test('cassandra: Create Table template + Drop confirm', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)

  await page.getByRole('button', { name: /Profiles Cassandra/ }).dblclick()
  await page.waitForTimeout(600)

  // keyspace context menu → Create Table… opens a CQL template
  await page.getByText('campus_ks').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Create Table…' }).click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('tab', { name: /New table/ }).first()).toBeVisible()
  await expect(page.locator('.view-lines').first()).toContainText('CREATE TABLE campus_ks.new_table')

  // navigate to a table and Drop → in-app confirm dialog
  await page.getByText('campus_ks').first().dblclick()
  await page.waitForTimeout(200)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  await page.getByText('students_by_id').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Drop', exact: true }).click()
  await page.waitForTimeout(200)
  await expect(page.getByText('Drop table').first()).toBeVisible()
  // backdrop click must NOT close the confirm (rule chung); Cancel closes it
  await page.mouse.click(6, 6)
  await expect(page.getByText('Drop table').first()).toBeVisible()
  await page.getByRole('button', { name: 'Confirm' }).click()
  await page.waitForTimeout(300)
  await expect(page.getByText(/Done/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
