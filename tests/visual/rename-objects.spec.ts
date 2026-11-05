import { expect, test, type Locator, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// 1) Rename… on a TABLE (and routines, databases, schemas) opens the shared Rename
//    popup — focused name field, checks before anything is sent, the exact
//    statement, run in place — instead of parking a placeholder in a SQL tab.
// 2) Names in the Cache & Streaming workspaces (topic, queue, stream/subject, key)
//    can be highlighted with the mouse to copy them; the drag does not select the row.

const lastSql = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ipcLastSql?: string }).__ipcLastSql ?? '')
const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls ?? {})

async function boot(page: Page, query = '') {
  await blockRemoteFonts(page)
  await page.goto(APP_URL + query)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
}

async function openTables(page: Page, conn: RegExp) {
  await page.getByRole('button', { name: conn }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  const schema = page.getByRole('treeitem', { name: /public/ }).first()
  if ((await schema.getAttribute('aria-expanded')) !== 'true') await schema.dblclick()
  await page.waitForTimeout(400)
  await page.getByRole('treeitem', { name: /Tables/ }).first().dblclick()
  await expect(page.getByRole('treeitem', { name: /students/ }).first()).toBeVisible()
}

test('rename a table: popup with checks, the exact statement, and the tree re-read', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)
  await openTables(page, /Postgres 10\.0\.1\.5/)

  await page.getByRole('treeitem', { name: /students/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename…' }).click()

  const dialog = page.getByRole('dialog', { name: 'Rename table' })
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('tab', { name: /Rename students/ })).toHaveCount(0)
  await expect(dialog).toContainText('public · PostgreSQL')
  const input = dialog.locator('#rn-name')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('students')
  const rename = dialog.getByRole('button', { name: 'Rename', exact: true })

  // unchanged, empty and already-used names are refused before anything is sent
  await expect(rename).toHaveAttribute('aria-disabled', 'true')
  await input.fill('')
  await expect(dialog).toContainText('Type a new name.')
  await expect(rename).toHaveAttribute('aria-disabled', 'true')
  await input.fill('Courses')
  await expect(dialog).toContainText('already exists in public')
  await expect(rename).toHaveAttribute('aria-disabled', 'true')

  // a free name shows the statement that will run
  await input.fill('pupils')
  await expect(dialog.locator('[data-rename-sql]')).toHaveText('ALTER TABLE "public"."students" RENAME TO "pupils";')
  await expect(rename).toHaveAttribute('aria-disabled', 'false')

  // backdrop click does not close a form popup
  await page.mouse.click(8, 8)
  await expect(dialog).toBeVisible()

  const before = (await calls(page)).list_tables ?? 0
  await input.press('Enter')
  await expect(dialog).toBeHidden({ timeout: 8000 })
  expect(await lastSql(page)).toBe('ALTER TABLE "public"."students" RENAME TO "pupils";')
  expect((await calls(page)).list_tables ?? 0).toBeGreaterThan(before)
  await expect(page.getByRole('treeitem', { name: /pupils/ }).first()).toBeVisible()
  await expect(page.getByRole('treeitem', { name: /^students/ })).toHaveCount(0)

  expect(errors, errors.join('\n')).toEqual([])
})

test('MySQL keeps the table in its database; Cancel and Open in SQL tab run nothing', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /MySQL localhost:3306/ }).first().click()
  await page.waitForTimeout(600)
  const db = page.getByRole('treeitem', { name: /public/ }).first()
  if ((await db.getAttribute('aria-expanded')) !== 'true') await db.dblclick()
  await page.waitForTimeout(400)
  await page.getByRole('treeitem', { name: /Tables/ }).first().dblclick()
  await page.getByRole('treeitem', { name: /students/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename…' }).click()

  const dialog = page.getByRole('dialog', { name: 'Rename table' })
  await dialog.locator('#rn-name').fill('pupils')
  await expect(dialog.locator('[data-rename-sql]')).toHaveText('RENAME TABLE `public`.`students` TO `public`.`pupils`;')

  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  expect((await calls(page)).exec_statement ?? 0).toBe(0)

  // Open in SQL tab: the statement goes to a tab for review, nothing runs
  await page.getByRole('treeitem', { name: /students/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  await dialog.locator('#rn-name').fill('pupils')
  await dialog.getByRole('button', { name: 'Open in SQL tab' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('tab', { name: /Rename students/ }).first()).toBeVisible()
  expect((await calls(page)).exec_statement ?? 0).toBe(0)
})

test('rename a function uses the same popup (no browser prompt)', async ({ page }) => {
  let prompted = false
  page.on('dialog', (d) => {
    prompted = true
    void d.dismiss()
  })
  await boot(page)
  await page.getByRole('button', { name: /Postgres 10\.0\.1\.5/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  const schema = page.getByRole('treeitem', { name: /public/ }).first()
  if ((await schema.getAttribute('aria-expanded')) !== 'true') await schema.dblclick()
  await page.waitForTimeout(400)
  await page.getByRole('treeitem', { name: /^.{0,3}Functions/ }).first().dblclick()
  await page.waitForTimeout(400)
  const fn = page.getByRole('treeitem', { name: /add_one/ }).first()
  await fn.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename…' }).click()

  const dialog = page.getByRole('dialog', { name: 'Rename function' })
  await expect(dialog).toBeVisible()
  await dialog.locator('#rn-name').fill('plus_one')
  await expect(dialog.locator('[data-rename-sql]')).toContainText('RENAME TO "plus_one";')
  await expect(dialog.locator('[data-rename-sql]')).toContainText('ALTER FUNCTION "public"."add_one"(')
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(dialog).toBeHidden({ timeout: 8000 })
  expect(await lastSql(page)).toContain('RENAME TO "plus_one"')
  expect(prompted, 'no window.prompt').toBe(false)
})

// ---------------------------------------------------------------------------
// Copyable names in the Cache & Streaming workspaces
// ---------------------------------------------------------------------------

/** Drag across the name of the SECOND row: the text is selected, the row is not.
 *  A plain click afterwards still selects the row. */
async function dragSelectsName(page: Page, shell: Locator, target?: Locator, nameSel = '.ds-name') {
  const row = target ?? shell.locator('tbody tr:has(.ds-name)').nth(1)
  await expect(row).toBeVisible()
  const name = row.locator(nameSel).first()
  expect(await name.evaluate((el) => getComputedStyle(el).userSelect)).toBe('text')
  const full = (await name.textContent())?.trim() ?? ''
  // the detail pane may still be opening from the previous click — measure once the
  // layout has settled
  await page.waitForTimeout(500)
  const box = (await name.boundingBox())!
  const wasSelected = await row.getAttribute('aria-selected')

  await page.mouse.move(box.x + 1, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
  const picked = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  expect(picked.length, `selected text of “${full}”`).toBeGreaterThan(2)
  expect(full.startsWith(picked.trim()), `“${picked}” is part of “${full}”`).toBe(true)
  // the drag did not select / open the row
  expect(await row.getAttribute('aria-selected')).toBe(wasSelected)

  // a plain click (no drag) on the same name still selects the row
  await name.click()
  await expect(row).toHaveAttribute('aria-selected', 'true')
}

test('Kafka topic names can be highlighted to copy', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /Events Kafka/ }).first().dblclick()
  const shell = page.locator('[data-stream-shell="kafka"]')
  await expect(shell).toBeVisible({ timeout: 8000 })
  await dragSelectsName(page, shell)
  // the selected topic's title in the detail pane is copyable too
  await expect(shell.locator('.kc-detail-title')).toHaveCSS('user-select', 'text')
})

test('NATS stream and subject names can be highlighted to copy', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  const shell = page.locator('[data-stream-shell="nats"]')
  await expect(shell).toBeVisible({ timeout: 8000 })
  await dragSelectsName(page, shell)
  // a subject row: its name selects too, and the drag does not select the row
  const sub = shell.locator('tbody tr[data-kind="subject"]').nth(1)
  await expect(sub).toBeVisible()
  await dragSelectsName(page, shell, sub, '.nc-subj')
})

test('RabbitMQ queue and Redis key names can be highlighted to copy', async ({ page }) => {
  await boot(page, '?rabbitmq=1')
  await page.getByRole('button', { name: /RabbitMQ 10\.0\.9\.4:15672/ }).dblclick()
  const rabbit = page.locator('[data-stream-shell="rabbitmq"]')
  await expect(rabbit).toContainText('RabbitMQ 3.13.7', { timeout: 8000 })
  await dragSelectsName(page, rabbit)

  await page.getByRole('button', { name: /Cache Redis 10\.0\.1\.7/ }).dblclick()
  const redis = page.locator('[data-stream-shell="redis"]')
  await expect(redis).toBeVisible({ timeout: 8000 })
  await dragSelectsName(page, redis)
})
