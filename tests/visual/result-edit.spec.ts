import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// A Query Editor result can be edited in place when it is a plain SELECT from one
// table carrying the table's primary key — every change then targets its row by
// key. Any other result stays read-only, and the toolbar says why.

async function newQuery(page: Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(200)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(200)
}

async function run(page: Page, sql: string) {
  await page.locator('.view-lines').first().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(sql)
  await page.keyboard.press('Escape') // close any suggestion popup
  await page.getByRole('button', { name: 'Run' }).first().click()
}

const cell = (page: Page, row: number, col: number) => page.locator('.grid-row').nth(row).locator('td:not(:first-child)').nth(col)
const readOnly = (page: Page) => page.getByRole('note', { name: /^Read-only:/ })

type Change = { kind: string; schema: string | null; table: string; pk: { name: string; value: unknown }[]; set: { name: string; value: unknown }[] }

test('a single-table SELECT with its key edits in place, saves, and re-reads the result', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await newQuery(page)
  await run(page, 'SELECT id, display_name, settings FROM profiles')
  await expect(page.getByText(/Rows 1–2 of 2/).first()).toBeVisible({ timeout: 10_000 })

  // editable: the edit toolbar is there, no read-only chip
  await expect(page.getByRole('button', { name: 'Insert row', exact: true })).toBeVisible()
  await expect(readOnly(page)).toHaveCount(0)

  // edit the JSON cell of row 1 in the JSON editor
  const settings = cell(page, 0, 2)
  await settings.dblclick()
  const dlg = page.getByRole('dialog', { name: 'Edit JSON cell' })
  await expect(dlg).toBeVisible()
  await page.locator('[role="dialog"] .view-lines').first().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type('{"theme":"ocean","alerts":true}')
  await dlg.getByRole('button', { name: 'Save' }).click()
  await expect(dlg).toBeHidden()
  // …and a plain text cell inline
  await cell(page, 1, 1).dblclick()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('Binh Tran')
  await page.keyboard.press('Enter')
  await expect(page.getByText(/2 unsaved changes/)).toBeVisible()

  // Execute writes by key, unqualified (same session resolves the same table)
  await page.getByRole('button', { name: 'Execute', exact: true }).click()
  await expect(page.getByText(/2 unsaved changes/)).toBeHidden()
  const changes = await page.evaluate(() => (window as unknown as { __ipcGridChanges?: Change[] }).__ipcGridChanges)
  expect(changes).toHaveLength(2)
  for (const c of changes!) {
    expect(c).toMatchObject({ kind: 'update', schema: null, table: 'profiles' })
  }
  expect(changes!.find((c) => c.set[0].name === 'settings')!.pk).toEqual([expect.objectContaining({ name: 'id', value: 1 })])
  expect(changes!.find((c) => c.set[0].name === 'display_name')!.pk).toEqual([expect.objectContaining({ name: 'id', value: 2 })])

  // the result is read again: the grid shows what the table now holds
  await expect(cell(page, 0, 2)).toContainText('ocean')
  await expect(cell(page, 1, 1)).toHaveText('Binh Tran')
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('results that do not map back to one table row stay read-only and say why', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await newQuery(page)

  const cases: [string, RegExp][] = [
    ['SELECT display_name, settings FROM profiles', /primary key \(id\)/],
    ['SELECT id, upper(display_name) FROM profiles', /plain columns/],
    ['SELECT * FROM profiles p JOIN students s ON s.id = p.id', /joins/],
    ['SELECT * FROM json_demo', /not a column/],
  ]
  for (const [sql, why] of cases) {
    await run(page, sql)
    await expect(readOnly(page)).toBeVisible({ timeout: 10_000 })
    await expect(readOnly(page)).toHaveAttribute('title', why)
    await expect(page.getByRole('button', { name: 'Insert row', exact: true })).toHaveCount(0)
  }
  // a read-only JSON cell still opens the viewer, never the editor
  await page.getByText('{ }').first().click()
  await expect(page.getByRole('dialog', { name: 'JSON cell' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'JSON cell' }).getByRole('button', { name: 'Save' })).toHaveCount(0)
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('Open Data shows every row of a large page (no hidden client pager on an editable grid)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(`${APP_URL}?viewerRows=1200`)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(300)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByRole('treeitem', { name: /students/ }).first().dblclick()
  await expect(page.getByRole('button', { name: 'Insert row', exact: true }).first()).toBeVisible({ timeout: 10_000 })
  await page.getByLabel('Page size').selectOption('500')
  await expect(page.getByText(/1–500 of/)).toBeVisible({ timeout: 10_000 })
  // no second, client-side pager inside the grid
  await expect(page.getByText(/^Rows 1–200 of/)).toHaveCount(0)
  // the last row of the page is reachable by scrolling the grid
  await page.locator('.rg-scroll').first().evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect(page.getByText('Student 500', { exact: true })).toBeVisible()
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('the cell being edited is framed and its selected text is legible (dark mode)', async ({ page }) => {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(300)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByRole('treeitem', { name: /students/ }).first().dblclick()
  await expect(page.getByRole('button', { name: 'Insert row', exact: true }).first()).toBeVisible({ timeout: 10_000 })

  await cell(page, 0, 1).dblclick()
  const input = page.locator('input.rg-edit')
  await expect(input).toBeFocused()
  const look = await input.evaluate((el) => {
    const sel = getComputedStyle(el, '::selection')
    const probe = document.createElement('div')
    probe.style.color = 'var(--grid-select)'
    document.body.appendChild(probe)
    const gridSelect = getComputedStyle(probe).color
    probe.remove()
    return { selBg: sel.backgroundColor, selFg: sel.color, gridSelect, frame: getComputedStyle(el).boxShadow }
  })
  // solid selection colour + white text, not the faint 26% tint
  expect(look.selBg).toBe(look.gridSelect)
  expect(look.selFg).toBe('rgb(255, 255, 255)')
  // a visible frame around the cell being edited
  expect(look.frame).toMatch(/inset/)
  await page.locator('.grid-row').first().screenshot({ path: 'test-results/edit-cell-dark.png' })
})
