import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Settings → MCP: the server is off by default, opt-in, and shows its URL +
// per-connection sharing once enabled.
test('Settings → MCP: enable, share a connection, see the URL', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.keyboard.press('Control+,')
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: 'MCP', exact: true }).click()
  await page.waitForTimeout(200)

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('MCP server').first()).toBeVisible()

  // Off by default → the port/URL block is hidden.
  await expect(dialog.getByText(/Running at/)).toHaveCount(0)

  // Enable it (the enable toggle is the first checkbox in the MCP panel).
  await dialog.locator('input[type="checkbox"]').first().check()
  await page.waitForTimeout(250)

  // Now it reports a localhost URL and warns that nothing is shared yet.
  await expect(dialog.getByText(/Running at http:\/\/127\.0\.0\.1/)).toBeVisible()
  await expect(dialog.getByText(/No connection is shared yet/)).toBeVisible()

  // Approval mode defaults to "Ask before writes".
  await expect(dialog.locator('select').filter({ hasText: 'Ask before writes' })).toBeVisible()

  // Share the first connection (tick its Readable box in the connections table).
  const readable = dialog.locator('.mcp-conns tbody tr').first().locator('input[type="checkbox"]').first()
  await readable.check()
  await page.waitForTimeout(250)
  await expect(dialog.getByText(/No connection is shared yet/)).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// The approval popup the server raises before a write: shows the agent's SQL and
// blocks until the person answers.
test('MCP approval popup shows the SQL and closes on Deny', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(`${APP_URL}?mcpApprove=1`)
  await page.waitForSelector('#app > *', { timeout: 15_000 })

  const dialog = page.getByRole('dialog', { name: 'MCP approval' })
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await expect(dialog.getByText(/wants to change data/)).toBeVisible()
  await expect(dialog.getByText(/UPDATE students SET status/)).toBeVisible()

  // backdrop does NOT close it
  await page.mouse.click(6, 6)
  await expect(dialog).toBeVisible()

  await dialog.getByRole('button', { name: 'Deny' }).click()
  await expect(dialog).toBeHidden()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
