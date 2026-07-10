import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Schema-level "Indexes" folder: lists every index in the schema, with a folder
// menu (Create Index / Filter / Refresh) and per-index menu (Alter / Drop / …).
test('explorer: schema-wide Indexes folder + context menus', async ({ page }) => {
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

  // the new folder sits alongside Tables/Views/… — click to load + expand
  const folder = page.getByText('Indexes', { exact: true }).first()
  await expect(folder).toBeVisible()
  await folder.dblclick() // double-click expands + loads (single-click only selects)
  await page.waitForTimeout(400)
  // schema-wide indexes render (from scan_indexes)
  await expect(page.getByText('idx_students_email').first()).toBeVisible()
  await expect(page.getByText('idx_enroll_sc').first()).toBeVisible()
  // primary-key indexes are excluded (only clustered/non-clustered secondary indexes)
  await expect(page.getByText('students_pkey')).toHaveCount(0)

  // folder context menu: Create Index / Refresh
  await page.getByText('Indexes', { exact: true }).first().click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Create Index…' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Refresh' }).first()).toBeVisible()
  await page.keyboard.press('Escape')

  // per-index context menu: Alter… / Drop…
  await page.getByText('idx_students_email').first().click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Alter…' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Drop…' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Alter…' }).click()
  await page.waitForTimeout(300)
  // Alter opens a SQL tab (view/edit — not executed) with the index's real definition
  // as a re-runnable DROP + CREATE reflecting its actual columns.
  const editor = page.locator('.cm-content').first()
  await expect(editor).toContainText('DROP INDEX')
  await expect(editor).toContainText('CREATE UNIQUE INDEX')
  await expect(editor).toContainText('idx_students_email')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
