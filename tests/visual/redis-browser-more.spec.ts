import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, previewBox, showFormatted } from './helpers'

// The checks the old Redis key tree (sidebar) carried, now on the Redis Browser
// workspace: Redis has no object tree, connecting opens its Browser (one tab per
// connection, the picked key in the side panel — SPEC-REDIS-BROWSER.md X1).

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

const count = (page: Page, c: string) =>
  page.evaluate((k) => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.[k] ?? 0, c)

test('redis: connecting opens the Browser (no tree); a key opens in the side panel, never its own tab', async ({ page }) => {
  const { shell, grid, errors } = await openBrowser(page)
  await expect(page.locator('[data-sidebar-panel="explorer"]')).toHaveCount(0)
  await expect(page.locator('[data-stream-shell="redis"]')).toHaveCount(1)

  await grid.getByText('leaderboard').click()
  await expect(grid.locator('tr[aria-selected="true"]')).toContainText('leaderboard')
  await expect(page.getByRole('tab', { name: /leaderboard · key/ })).toHaveCount(0)
  // a second key reuses the same tab (still one Redis workspace)
  await grid.getByText('session:abc123').click()
  await expect(page.locator('[data-stream-shell="redis"]')).toHaveCount(1)
  await expect(page.getByRole('tab', { name: /session:abc123/ })).toHaveCount(0)
  await grid.getByText('leaderboard').click()

  // value grid shows members + View JSON + Copy actions per value
  await expect(shell.getByText('an', { exact: true }).first()).toBeVisible()
  await expect(shell.getByTitle('View as JSON').first()).toBeVisible()
  await expect(shell.getByTitle('Copy value').first()).toBeVisible()

  // the JSON viewer popup: the value must be VISIBLE, not just held in the model —
  // a collapsed viewer box (a few pixels tall) is the regression here
  await shell.getByTitle('View as JSON').first().click()
  await page.waitForTimeout(600)
  await showFormatted(page)
  await page.waitForTimeout(600)
  const view = await previewBox(page, 'Payload')
  expect(view.text, 'payload viewer is empty').not.toBe('')
  expect(view.height, `payload viewer collapsed (${view.height}px)`).toBeGreaterThan(100)
  expect(view.rendered.trim(), 'payload not rendered').not.toBe('')
  await page.getByText('Close', { exact: true }).first().click()

  // Set expiry is a form (dialog with an input), Delete an in-app confirm
  await shell.getByRole('button', { name: 'Set expiry…' }).click()
  const ttl = page.getByRole('dialog')
  await expect(ttl.getByText('Set expiry', { exact: true })).toBeVisible()
  await expect(ttl.getByPlaceholder(/no expiry/)).toBeVisible()
  await ttl.getByRole('button', { name: 'Cancel' }).click()
  await shell.getByRole('button', { name: 'Delete…' }).click()
  await expect(page.getByRole('dialog').getByText('Delete this key', { exact: true })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  expect(errors, errors.join('\n')).toEqual([])
})

test('redis: the Add key form stays open on a backdrop click; Pub/Sub is a section', async ({ page }) => {
  const { shell, errors } = await openBrowser(page)
  await shell.getByRole('button', { name: '+ Add key' }).click()
  const add = page.getByRole('dialog', { name: /Add key/ })
  await expect(add).toBeVisible()
  await add.getByLabel('Key name').fill('greeting')
  // global rule: clicking the backdrop (outside the form) must NOT close it
  await page.mouse.click(8, 8)
  await expect(add).toBeVisible()
  await add.getByRole('button', { name: 'Cancel' }).click()
  await expect(add).toHaveCount(0)

  await shell.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /^Pub\/Sub/ }).click()
  await expect(shell.getByText('Pub/Sub Monitor')).toBeVisible()
  expect(errors, errors.join('\n')).toEqual([])
})

test('redis: a Tree folder deletes every key under its prefix on the server; Refresh re-scans', async ({ page }) => {
  const { shell, grid, errors } = await openBrowser(page)
  await shell.getByRole('group', { name: 'Show keys as' }).getByRole('button', { name: 'Tree' }).click()
  const tree = shell.getByRole('tree', { name: 'Keys by prefix' })
  const folder = tree.getByRole('treeitem').filter({ has: page.locator('.rb-seg-name', { hasText: /^user$/ }) }).first()
  await expect(folder).toBeVisible()

  const delBefore = await count(page, 'redis_del')
  await folder.hover()
  await folder.getByRole('button', { name: 'Delete keys under user' }).click()
  const dlg = page.getByRole('alertdialog', { name: 'Delete keys under a prefix' })
  await expect(dlg).toContainText('This cannot be undone')
  await page.mouse.click(8, 8) // the backdrop does not dismiss it
  await expect(dlg).toBeVisible()
  await dlg.getByRole('button', { name: /^Delete \d/ }).click()
  await expect(dlg).toHaveCount(0)
  expect(await count(page, 'redis_del'), 'DEL sent to Redis for each key').toBeGreaterThan(delBefore)
  // the demo store is stateful: the keys are really gone after the reload
  await expect(tree.getByRole('treeitem').filter({ has: page.locator('.rb-seg-name', { hasText: /^user$/ }) })).toHaveCount(0)
  await expect(tree.getByText('leaderboard')).toBeVisible()

  // Refresh → a fresh SCAN from Redis
  const scanBefore = await count(page, 'redis_scan')
  await shell.getByRole('button', { name: /^Refresh/ }).first().click()
  await expect.poll(() => count(page, 'redis_scan')).toBeGreaterThan(scanBefore)
  await shell.getByRole('group', { name: 'Show keys as' }).getByRole('button', { name: 'List' }).click()
  await expect(grid.getByText('leaderboard')).toBeVisible()
  expect(errors, errors.join('\n')).toEqual([])
})

// Load cost: opening the Browser must SCAN once, and typing in the pattern box must
// be debounced instead of re-scanning the whole keyspace on every keystroke.
test('redis: one SCAN on open, debounced pattern box', async ({ page }) => {
  const { shell, errors } = await openBrowser(page)
  await page.waitForTimeout(700)
  const onOpen = await count(page, 'redis_scan')
  expect(onOpen, 'open scans once, not once per effect').toBeLessThanOrEqual(1)

  // six keystrokes → one reload after the last one (not six full scans)
  await shell.getByLabel('Key pattern').pressSequentially('user:*', { delay: 40 })
  await page.waitForTimeout(900)
  const whileTyping = (await count(page, 'redis_scan')) - onOpen
  expect(whileTyping, 'the pattern still triggers a reload').toBeGreaterThan(0)
  expect(whileTyping, 'debounced: far fewer scans than keystrokes').toBeLessThanOrEqual(2)
  expect(errors, errors.join('\n')).toEqual([])
})

test('redis: the database picker defaults to Database 0 and lists the databases', async ({ page }) => {
  const { shell, grid, errors } = await openBrowser(page)
  const picker = shell.getByLabel('Database to browse')
  await expect(picker).toHaveValue('0')
  const options = picker.locator('option')
  expect(await options.count()).toBeGreaterThan(1)
  await expect(options.first()).toHaveText(/^Database 0/)
  await picker.selectOption('1')
  await expect(picker).toHaveValue('1')
  await expect(grid.getByText('jobs:pending')).toBeVisible({ timeout: 8000 })
  expect(errors, errors.join('\n')).toEqual([])
})
