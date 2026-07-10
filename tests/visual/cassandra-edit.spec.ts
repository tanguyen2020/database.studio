import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Phase C3 — Cassandra tables open an editable data viewer. Editing a cell buffers
// a pending change; Preview shows the CQL and Execute applies it (UPDATE by PK).
test('cassandra: editable data grid — edit cell + preview + execute', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)

  await page.getByRole('button', { name: /Profiles Cassandra/ }).dblclick()
  await page.waitForTimeout(600)

  // navigate to the table and open the editable data viewer
  await page.getByText('campus_ks').first().dblclick()
  await page.waitForTimeout(200)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  await page.getByText('students_by_id').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open Data (editable)' }).click()
  await page.waitForTimeout(500)

  // the viewer tab + rows render
  await expect(page.getByRole('tab', { name: /campus_ks\.students_by_id/ }).first()).toBeVisible()
  const cell = page.getByText('Student 0', { exact: true }).first()
  await expect(cell).toBeVisible()

  // edit the name cell → buffers a pending change
  await cell.dblclick()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('Student ZERO')
  await page.keyboard.press('Enter')
  await expect(page.getByText(/unsaved change/).first()).toBeVisible()

  // Preview diff shows the change, then Apply commits it (UPDATE by PK)
  await page.getByText('Preview diff').first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/update/i).first()).toBeVisible()
  await page.getByText('Apply', { exact: true }).first().click()
  await page.waitForTimeout(400)
  await expect(page.getByText(/Applied/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
