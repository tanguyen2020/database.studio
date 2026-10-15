import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Drop Database on a database OTHER sessions are using: the server refuses
// ("is being accessed by other users" / "currently in use" / lock wait timeout /
// ORA-01940). The popup must list those sessions and let the user kill them —
// one by one, or all at once followed by the drop — instead of a dead-end error.
// `?dbInUse=2` makes the demo server hold every database with 2 sessions.
const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls ?? {})

async function openDropDialog(page: Page, url: string, conn: RegExp, node: RegExp) {
  await blockRemoteFonts(page)
  await page.goto(url)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: conn }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  const item = page.getByRole('treeitem', { name: node }).first()
  await expect(item).toBeVisible()
  await item.click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByRole('menuitem', { name: 'Drop Database…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Drop database' })
  await expect(dialog).toBeVisible()
  return { dialog, item }
}

test('a database held by other sessions lists them, kills them and drops', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const { dialog } = await openDropDialog(page, `${APP_URL}?dbInUse=2`, /Postgres/, /analytics/)

  await dialog.getByRole('button', { name: 'Drop', exact: true }).click()

  // the refusal turns into the session list — not a toast, not a closed dialog
  await expect(dialog).toContainText('Database in use')
  await expect(dialog).toContainText('2 other sessions')
  await expect(dialog).toContainText('is being accessed by other users') // the server's own words
  const rows = dialog.getByRole('table', { name: 'Sessions holding the database' }).locator('tbody tr')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('api-server')
  await expect(rows.first()).toContainText('10.0.7.20')
  // still in the tree — nothing dropped yet
  await expect(page.getByRole('treeitem', { name: /analytics/ }).first()).toBeVisible()

  // backdrop click does not close it (rule chung for confirm/form popups)
  await page.mouse.click(8, 8)
  await expect(dialog).toBeVisible()

  // kill ONE → it leaves the list, the database is still there
  const firstPid = (await rows.first().locator('td').first().innerText()).trim()
  await dialog.getByRole('button', { name: `Kill session ${firstPid}` }).click()
  await expect(rows).toHaveCount(1)
  await expect(dialog).not.toContainText(firstPid)
  expect((await calls(page)).kill_session).toBe(1)
  await expect(page.getByRole('treeitem', { name: /analytics/ }).first()).toBeVisible()

  // kill the rest & drop → the drop runs again and succeeds; the tree is re-read
  const before = await calls(page)
  await dialog.getByRole('button', { name: 'Kill 1 session & drop' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const after = await calls(page)
  expect(after.kill_session).toBe(2)
  expect(after.drop_database).toBe((before.drop_database ?? 0) + 1)
  expect(after.list_schemas ?? 0).toBeGreaterThan(before.list_schemas ?? 0)
  expect(await page.evaluate(() => (window as unknown as { __ipcLastSql?: string }).__ipcLastSql)).toBe('DROP DATABASE IF EXISTS "analytics";')
  await expect(page.getByRole('treeitem', { name: /analytics/ })).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('sessions that reconnect after the kill are shown again, not silently ignored', async ({ page }) => {
  const { dialog } = await openDropDialog(page, `${APP_URL}?dbInUse=2&dbInUseRespawn=1`, /Postgres/, /analytics/)
  await dialog.getByRole('button', { name: 'Drop', exact: true }).click()
  await dialog.getByRole('button', { name: 'Kill 2 sessions & drop' }).click()

  // a pool reconnected → the server still refuses → the list is back + an explanation
  await expect(dialog).toContainText('reconnected')
  const rows = dialog.getByRole('table', { name: 'Sessions holding the database' }).locator('tbody tr')
  await expect(rows).not.toHaveCount(0)
  await expect(page.getByRole('treeitem', { name: /analytics/ }).first()).toBeVisible()

  // killing again (the pool stays down this time) finally drops it
  await dialog.getByRole('button', { name: /^Kill \d+ sessions? & drop$/ }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('treeitem', { name: /analytics/ })).toHaveCount(0)
})

test('MySQL: a lock wait timeout shows the lock holders, Cancel leaves the database', async ({ page }) => {
  const { dialog } = await openDropDialog(page, `${APP_URL}?dbInUse=2`, /MySQL localhost:3306/, /public/)
  await expect(dialog).toContainText('DROP DATABASE IF EXISTS `public`;')
  await dialog.getByRole('button', { name: 'Drop', exact: true }).click()

  await expect(dialog).toContainText('locked by 2 other sessions')
  await expect(dialog).toContainText('Lock wait timeout exceeded')
  // MySQL tells lock holders apart from idle `USE db` sessions
  await expect(dialog.getByRole('columnheader', { name: 'Lock' })).toBeVisible()
  await expect(dialog.getByText('holds lock')).toHaveCount(1)

  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect((await calls(page)).kill_session ?? 0).toBe(0)
  await expect(page.getByRole('treeitem', { name: /public/ }).first()).toBeVisible()
})
