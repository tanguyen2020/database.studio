import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Editing a JSON cell: a document does not fit the one-line inline editor, so a
// json/jsonb cell opens the JSON editor (validate → Format → Save into the same
// pending buffer Execute writes from). A text column holding a document edits as
// text (verbatim, no silent reformat); a read-only grid keeps the viewer.

async function openStudentsViewer(page: import('@playwright/test').Page) {
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByRole('treeitem', { name: /students/ }).first().dblclick()
  await expect(page.getByText('＋ Insert row', { exact: true }).first()).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(300)
}

type View = { getModel: () => { getValue: () => string } | null }

/** Text of the JSON editor, read from the MODEL: Monaco splits the rendered text
 *  into token spans, so scraping the DOM would be brittle. `__dsViews` is the
 *  browser/demo-only seam CodeView registers itself in. */
async function jsonText(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const views = (window as unknown as { __dsViews?: View[] }).__dsViews ?? []
    return views[views.length - 1]?.getModel()?.getValue() ?? null
  })
}

/** Replace the whole document by typing, the way a user would. */
async function setJson(page: import('@playwright/test').Page, text: string) {
  await page.locator('[role="dialog"] .view-lines').first().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(text)
  await page.waitForTimeout(150)
}

/** the cell of column `col` (0-based across the data columns) on data row `row`. */
function cell(page: import('@playwright/test').Page, row: number, col: number) {
  return page.locator('.grid-row').nth(row).locator('td:not(:first-child)').nth(col)
}

test('json cell: double-click opens the JSON editor, validates, and saves as a pending change', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await openStudentsViewer(page)

  // the jsonb cell carries the { } badge
  const configCell = cell(page, 0, 3)
  await expect(configCell.getByText('{ }')).toBeVisible()

  // double-click opens the JSON editor (NOT the one-line inline input)
  await configCell.dblclick()
  const dlg = page.getByRole('dialog', { name: 'Edit JSON cell' })
  await expect(dlg).toBeVisible()
  await expect(page.locator('.grid-row input')).toHaveCount(0)
  await expect(dlg.getByLabel('JSON value')).toBeFocused()
  // opened pretty-printed on the current value
  expect(await jsonText(page)).toContain('"theme": "dark"')
  // header names the column and its type
  await expect(dlg.getByText('config', { exact: true })).toBeVisible()
  await expect(dlg.getByText(/row 1 · jsonb/)).toBeVisible()

  // invalid JSON blocks Save and says why
  await setJson(page, '{"theme": }')
  await expect(dlg.getByText(/Invalid JSON/)).toBeVisible()
  await expect(dlg.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'true')

  // clicking the backdrop must NOT discard the draft (form-dialog rule)
  await page.mouse.click(8, 8)
  await expect(dlg).toBeVisible()
  expect(await jsonText(page)).toBe('{"theme": }')

  // valid JSON → Format pretty-prints it, Save closes and records the change
  await setJson(page, '{"theme":"solarized","tags":["x"]}')
  await expect(dlg.getByText(/^Valid JSON/)).toBeVisible()
  await dlg.getByRole('button', { name: 'Format' }).click()
  expect(await jsonText(page)).toContain('\n  "theme": "solarized"')
  await dlg.getByRole('button', { name: 'Save' }).click()
  await expect(dlg).toBeHidden()

  // the cell shows the new document and it is pending (not yet written)
  await expect(configCell).toContainText('solarized')
  await expect(page.getByText(/1 unsaved change\(s\)/)).toBeVisible()

  // …and it really is in the buffer Execute uses
  await page.getByText('Preview diff', { exact: true }).click()
  await expect(page.getByText(/UPDATE students/)).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('json cell: NULL cells, text columns and read-only grids', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await openStudentsViewer(page)

  // a NULL json cell has no badge, but Enter on it still opens the editor — empty,
  // so a document can be written into it.
  const nullConfig = cell(page, 2, 3)
  await expect(nullConfig.getByText('{ }')).toHaveCount(0)
  await nullConfig.click()
  await page.keyboard.press('Enter')
  const dlg = page.getByRole('dialog', { name: 'Edit JSON cell' })
  await expect(dlg).toBeVisible()
  expect(await jsonText(page)).toBe('')
  await expect(dlg.getByText(/Empty — saves NULL/)).toBeVisible()
  await setJson(page, '{"seeded":true}')
  await page.keyboard.press('Control+Enter') // Ctrl+Enter saves
  await expect(dlg).toBeHidden()
  await expect(nullConfig).toContainText('seeded')

  // a text column holding a document opens VERBATIM (no silent reformat) and says
  // it is stored as text
  const prefs = cell(page, 0, 4)
  await prefs.dblclick()
  await expect(dlg).toBeVisible()
  expect(await jsonText(page)).toBe('{"lang":"vi"}')
  await expect(dlg.getByText(/stores it as text/)).toBeVisible()
  await setJson(page, '{"lang":"en"}')
  await dlg.getByRole('button', { name: 'Save' }).click()
  await expect(dlg).toBeHidden()
  await expect(prefs).toContainText('{"lang":"en"}')
  await expect(page.getByText(/2 unsaved change\(s\)/)).toBeVisible()

  // read-only grid (query editor result): the badge opens the VIEWER — no Save
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(200)
  await page.locator('.view-lines').first().click()
  await page.keyboard.type('SELECT * FROM json_demo')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await expect(page.getByText(/Rows 1–1 of 1/).first()).toBeVisible({ timeout: 10_000 })
  await page.getByText('{ }').first().click()
  const view = page.getByRole('dialog', { name: 'JSON cell' })
  await expect(view).toBeVisible()
  expect(await jsonText(page)).toContain('"kind": "read-only"')
  await expect(view.getByRole('button', { name: 'Save' })).toHaveCount(0)
  await view.getByRole('button', { name: 'Close' }).click()
  await expect(view).toBeHidden()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
