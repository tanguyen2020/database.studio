import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Redis Browser workspace (SPEC-REDIS-BROWSER.md): keys on the left, the selected key in
// the side panel on the right (never a tab per key), plus Workbench · Pub/Sub · Slow
// commands · Server info. The demo Redis is stateful (src/lib/redis/demo.ts), so every
// edit made here is what the next read returns.

async function openBrowser(page: Page, query = '') {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL + query)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Cache Redis 10\.0\.1\.7/ }).dblclick()
  const shell = page.locator('[data-stream-shell="redis"]')
  await expect(shell).toBeVisible()
  const grid = shell.getByRole('grid', { name: 'Keys' })
  await expect(grid.getByText('leaderboard')).toBeVisible({ timeout: 8000 })
  return { shell, grid, errors }
}

const section = (page: Page, name: RegExp) =>
  page.locator('[data-stream-shell="redis"]').getByRole('navigation', { name: 'Sections' }).getByRole('button', { name })

test('add, rename, expire and delete a key without leaving the Browser', async ({ page }) => {
  const { shell, grid, errors } = await openBrowser(page)
  const tabsBefore = await page.getByRole('tab').count()

  // Add key → it appears in the list and opens in the side panel
  await shell.getByRole('button', { name: '+ Add key' }).click()
  const add = page.getByRole('dialog', { name: 'Add key' })
  await add.getByLabel('Key name').fill('order:9001')
  await add.getByLabel('Key value').fill('{"total":12.5}')
  await add.getByRole('button', { name: 'Create key' }).click()
  await expect(add).toHaveCount(0)
  await expect(grid.locator('tr[aria-selected="true"]')).toContainText('order:9001')

  // Rename (RENAMENX) → the list follows the new name, the old one is gone
  await shell.getByRole('button', { name: 'Rename…' }).click()
  const ren = page.getByRole('dialog').filter({ hasText: 'Rename key' })
  await ren.locator('input').fill('order:9002')
  await ren.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(grid.getByText('order:9002')).toBeVisible()
  await expect(grid.getByText('order:9001')).toHaveCount(0)

  // Set expiry → the Expires column shows a time instead of "Never"
  await shell.getByRole('button', { name: 'Set expiry…' }).click()
  const ttl = page.getByRole('dialog').filter({ hasText: 'Set expiry' })
  await ttl.getByPlaceholder(/no expiry/).fill('3600')
  await ttl.getByRole('button', { name: 'Save' }).click()
  await expect(grid.locator('tr', { hasText: 'order:9002' })).toContainText('1 h')

  // Delete → confirm → gone from the list, panel closed
  await shell.getByRole('button', { name: 'Delete…' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete key' }).click()
  await expect(grid.getByText('order:9002')).toHaveCount(0)
  await expect(shell.getByRole('button', { name: 'Set expiry…' })).toHaveCount(0)

  // never a tab per key
  expect(await page.getByRole('tab').count()).toBe(tabsBefore)
  expect(errors, errors.join('\n')).toEqual([])
})

test('edit a value and remove an item in the side panel', async ({ page }) => {
  const { shell, grid, errors } = await openBrowser(page)

  // Text: edit → Save → the server (stateful demo) returns the new value on reload
  await grid.getByText('cache:home').click()
  const text = shell.locator('textarea.rk-text')
  await expect(text).toHaveValue('demo-value')
  await text.fill('fresh-value')
  await shell.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForTimeout(300)
  await grid.getByText('leaderboard').click()
  await grid.getByText('cache:home').click()
  await expect(shell.locator('textarea.rk-text')).toHaveValue('fresh-value')

  // Hash: remove one field → it is gone after the re-read, the others stay
  await grid.getByText('user:1001').click()
  await expect(shell.getByText('email', { exact: true })).toBeVisible()
  const row = shell.locator('table.rk-table tr', { hasText: 'an@acme.io' })
  await row.hover()
  await row.getByTitle('Delete this item').click()
  const confirm = page.getByRole('dialog').last()
  const del = confirm.getByRole('button', { name: /^Delete/ })
  if (await del.count()) await del.last().click()
  await expect(shell.getByText('email', { exact: true })).toHaveCount(0)
  await expect(shell.getByText('role', { exact: true })).toBeVisible()
  expect(errors, errors.join('\n')).toEqual([])
})

test('edit one item of a hash, list, set and sorted set', async ({ page }) => {
  const { shell, grid, errors } = await openBrowser(page)
  const panel = shell.locator('table.rk-table')
  const editRow = async (text: string) => {
    const row = panel.locator('tbody tr', { has: page.getByText(text, { exact: true }) }).first()
    await row.hover()
    await row.getByTitle('Edit this item').click()
    return page.getByRole('dialog').last()
  }

  // Hash: rename a field and change its value in one save
  await grid.getByText('user:1001').click()
  let dlg = await editRow('an@acme.io')
  await expect(dlg).toHaveAttribute('aria-label', 'Edit field')
  await dlg.getByLabel('Field').fill('mail')
  await dlg.locator('textarea').fill('an@new.io')
  await dlg.getByRole('button', { name: 'Save' }).click()
  await expect(dlg).toHaveCount(0)
  await expect(panel.locator('tr', { hasText: 'mail' })).toContainText('an@new.io')
  await expect(panel.getByText('email', { exact: true })).toHaveCount(0)
  // renaming onto an existing field is refused, in the dialog, nothing changes
  dlg = await editRow('an@new.io')
  await dlg.getByLabel('Field').fill('role')
  await dlg.getByRole('button', { name: 'Save' }).click()
  await expect(dlg.getByRole('alert')).toContainText('already used')
  await dlg.getByRole('button', { name: 'Cancel' }).click()
  await expect(panel.locator('tr', { hasText: 'role' })).toContainText('admin')

  // List with a duplicate: removing item 0 removes only that one, not every "a"
  await shell.getByRole('button', { name: '+ Add key' }).click()
  const add = page.getByRole('dialog', { name: 'Add key' })
  await add.getByRole('radio', { name: 'List' }).click()
  await add.getByLabel('Key name').fill('dup:list')
  await add.getByLabel('Key value').fill('a\nb\na')
  await add.getByRole('button', { name: 'Create key' }).click()
  await expect(panel.locator('tbody tr')).toHaveCount(3)
  const first = panel.locator('tbody tr').first()
  await first.hover()
  await first.getByTitle('Delete this item').click()
  await expect(panel.locator('tbody tr')).toHaveCount(2)
  await expect(panel.locator('tbody tr').nth(0)).toContainText('b')
  await expect(panel.locator('tbody tr').nth(1)).toContainText('a')
  // edit item 1 in place
  dlg = await editRow('a')
  await expect(dlg).toHaveAttribute('aria-label', /Edit item/)
  await dlg.locator('textarea').fill('c')
  await dlg.locator('textarea').press('Control+Enter')
  await expect(panel.locator('tbody tr').nth(1)).toContainText('c')

  // Set: rename a member
  await grid.getByText('tags:popular').click()
  dlg = await editRow('svelte')
  await dlg.getByLabel('Member').fill('sveltekit')
  await dlg.getByRole('button', { name: 'Save' }).click()
  await expect(panel.getByText('sveltekit', { exact: true })).toBeVisible()
  await expect(panel.getByText('svelte', { exact: true })).toHaveCount(0)

  // Sorted set: a score must be a number; a valid one reorders the list
  await grid.getByText('leaderboard').click()
  dlg = await editRow('chi')
  await dlg.getByLabel('Score').fill('abc')
  await dlg.getByRole('button', { name: 'Save' }).click()
  await expect(dlg.getByRole('alert')).toContainText('must be a number')
  await dlg.getByLabel('Score').fill('999')
  await dlg.getByRole('button', { name: 'Save' }).click()
  await expect(panel.locator('tr', { hasText: 'chi' })).toContainText('999')

  // Stream entries can be removed but never edited
  await grid.getByText('events:orders').click()
  const entry = panel.locator('tbody tr').first()
  await entry.hover()
  await expect(entry.getByTitle('Edit this item')).toHaveCount(0)
  await expect(entry.getByTitle('Delete this item')).toBeVisible()
  expect(errors, errors.join('\n')).toEqual([])
})

test('List / Tree views, type filter and partial scan', async ({ page }) => {
  const { shell, grid, errors } = await openBrowser(page)

  // type filter: only hashes
  await shell.getByLabel('Show keys of type').selectOption({ label: 'Hash' })
  await expect(grid.getByText('user:1001')).toBeVisible()
  await expect(grid.getByText('leaderboard')).toHaveCount(0)
  await shell.getByLabel('Show keys of type').selectOption({ index: 0 })

  // Tree: keys grouped by prefix
  await shell.getByRole('group', { name: 'Show keys as' }).getByRole('button', { name: 'Tree' }).click()
  const tree = shell.getByRole('tree', { name: 'Keys by prefix' })
  await expect(tree.getByText('session', { exact: true })).toBeVisible()
  await shell.getByRole('group', { name: 'Show keys as' }).getByRole('button', { name: 'List' }).click()
  await expect(grid.getByText('leaderboard')).toBeVisible()

  // a pattern on a big keyspace stops early → flagged, and "Scan more" continues
  await shell.getByLabel('Key pattern').fill('big:')
  await expect(shell.getByText(/Partial list · read ~/)).toBeVisible({ timeout: 8000 })
  // (the list is virtualised, so count the keys read, not the rows painted)
  const readSoFar = async () => Number(((await shell.getByText(/Partial list · read ~/).innerText()).match(/read ~([\d,]+)/)?.[1] ?? '0').replace(/,/g, ''))
  const before = await readSoFar()
  expect(before).toBeGreaterThan(0)
  await shell.getByRole('button', { name: 'Scan more' }).click()
  await expect.poll(readSoFar).toBeGreaterThan(before)
  await expect(grid.getByText('big:000000')).toBeVisible()
  expect(errors, errors.join('\n')).toEqual([])
})

test('switching database shows the scan and locks the picker until it lands', async ({ page }) => {
  const { shell, grid, errors } = await openBrowser(page, '?slowRedis=600')
  const picker = shell.getByLabel('Database to browse')
  await picker.selectOption('1')
  await expect(picker).toBeDisabled()
  await expect(grid.getByText('jobs:pending')).toBeVisible({ timeout: 10_000 })
  await expect(grid.getByText('leaderboard')).toHaveCount(0)
  await expect(picker).toBeEnabled()
  expect(errors, errors.join('\n')).toEqual([])
})

test('Workbench, Slow commands and Server info sections', async ({ page }) => {
  const { shell, errors } = await openBrowser(page)

  await section(page, /^Workbench/).click()
  await shell.getByLabel('Redis command').fill('PING')
  await shell.getByLabel('Redis command').press('Enter')
  await expect(shell.getByText('PONG')).toBeVisible()

  await section(page, /^Slow commands/).click()
  const slow = shell.getByRole('grid', { name: 'Slow commands' })
  await expect(slow.locator('tbody tr').first()).toBeVisible()
  await expect(shell.getByText(/Commands slower than .* are logged\. The server keeps/)).toBeVisible()

  await section(page, /^Server info/).click()
  await expect(shell.getByRole('region', { name: 'Server' })).toBeVisible()
  await expect(shell.getByRole('region', { name: 'Memory' })).toBeVisible()
  expect(errors, errors.join('\n')).toEqual([])
})

test('Delete all keys names the count and empties the database', async ({ page }) => {
  const { shell, grid, errors } = await openBrowser(page)
  await shell.getByRole('button', { name: /Delete all keys/ }).click()
  const dlg = page.getByRole('alertdialog', { name: 'Delete all keys' })
  await expect(dlg).toContainText('9')
  await dlg.getByRole('button', { name: /Delete/ }).last().click()
  await expect(grid.getByText('leaderboard')).toHaveCount(0)
  expect(errors, errors.join('\n')).toEqual([])
})
