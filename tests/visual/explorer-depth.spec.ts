import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

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
  await openDatabaseNode(page)

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
  await expect(page.locator('.view-lines').first()).toContainText('CREATE')

  // View column expansion: expand Views → vw_active_students columns via chevron
  await page.getByText('Views', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  await page.getByRole('treeitem', { name: /vw_active_students/ }).first().getByRole('button').first().click()
  await page.waitForTimeout(300)
  // a view keeps its columns in a Columns folder, same as a table
  await page.getByRole('treeitem', { name: /Columns/ }).first().getByRole('button').first().click()
  await page.waitForTimeout(300)
  await expect(page.getByText('first_name').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// A table's indexes must be reachable from the tree — in EVERY database, and even
// when the server refuses to list them. The node used to be conditional, so an
// empty list and a failed query both rendered as "no node at all": there was no
// way to ask the tree what indexes a table has, and no hint that something broke.
test('Indexes sits under Columns and always renders', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)

  // --- current database ---
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  const chevron = (name: string) => page.getByTitle(name, { exact: true }).first().locator('span').first()
  await chevron('students').click()
  await page.waitForTimeout(600)

  // Columns first, then Indexes, then Constraints — the order the tree promises
  const rows = page.locator('[role="treeitem"]')
  const all = await rows.allInnerTexts()
  const at = all.findIndex((t) => t.includes('students'))
  const under = all.slice(at + 1, at + 4).map((t) => t.replace(/\s+/g, " ").trim())
  expect(under[0]).toContain('Columns')
  expect(under[1]).toContain('Indexes')
  expect(under[2]).toContain('Constraints')

  // and it opens onto the real index names
  await chevron('Indexes').click()
  await page.waitForTimeout(300)
  await expect(page.getByTitle('students_pkey', { exact: true }).first()).toBeVisible()

  // (the same three folders in a FOREIGN database are asserted by
  //  explorer-databases.spec.ts, which already drives that subtree)

  expect(errors, `page errors: ${errors.join("\n")}`).toEqual([])
})

// When the server refuses to list indexes, the node still shows — saying so —
// instead of disappearing and looking like a table with no indexes.
test('a failed index lookup is reported, not swallowed', async ({ page }) => {
  await blockRemoteFonts(page)
  await page.goto(APP_URL + '?indexesFail=1')
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByTitle('students', { exact: true }).first().locator('span').first().click()
  await page.waitForTimeout(600)

  const node = page.getByRole('treeitem', { name: /Indexes/ }).first()
  await expect(node).toBeVisible()
  await expect(node).toContainText('unavailable')
  await expect(node.locator('[title*="permission denied"]').first()).toBeVisible()
})
