import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// A tab that ran fine, then sat idle: the server reaps the connection, and the
// next Execute fails. What used to happen is that the failure surfaced as a raw
// wire error while the connection list still showed a green "connected" dot and
// nothing offered a way back. Now the failure closes the connection in the UI
// and puts a Reconnect button in front of the user.
//
// `?connLost=1` is a demo/browser seam (like `?slowRedis`): the NEXT statement
// comes back as the backend's `CONNECTION_LOST` error, once.
test('query editor: a lost connection turns into a Reconnect banner, and reconnecting restores Run', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(`${APP_URL}?connLost=1`)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)

  // Query console on the Postgres connection (unique host text in the sidebar).
  await page.getByText('10.0.1.5', { exact: false }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('New Query Console', { exact: true }).first().click()
  await page.waitForTimeout(600)

  // Tabs stay mounted once shown (keep-alive), so every open tab on the dead
  // connection carries the banner — `banners` counts them all, `banner` is the
  // one on screen (the active tab renders first).
  const banners = page.getByTestId('disconnected-banner')
  const banner = banners.first()
  await expect(banners).toHaveCount(0)

  // Run → the connection turns out to be dead.
  const editor = page.locator('.view-lines').first()
  await editor.click()
  await page.keyboard.type('SELECT 1;')
  await page.keyboard.press('F5')
  await page.waitForTimeout(700)

  // The tab says what happened and offers exactly one way forward.
  await expect(banner).toBeVisible()
  await expect(banner.getByText('Connection lost', { exact: true })).toBeVisible()
  await expect(banner).toContainText(/server closed it/i)
  const reconnect = banner.getByRole('button', { name: /Reconnect/ })
  await expect(reconnect).toBeVisible()

  // Reconnect → the banner clears (the connection is open again)…
  await reconnect.click()
  await expect(banners).toHaveCount(0, { timeout: 5_000 })

  // …and the editor runs again (the seam is consumed, one failure only).
  await editor.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('SELECT * FROM students;')
  await page.keyboard.press('F5')
  await page.waitForTimeout(700)
  await expect(page.getByText(/Rows 1–\d+ of/).first()).toBeVisible()
  await expect(banners).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// The other half of the complaint: while the query failed, the sidebar kept
// claiming the connection was up. The dot must go red the moment a run finds
// the socket dead.
test('connections list: the dot stops claiming "connected" after a lost connection', async ({ page }) => {
  await blockRemoteFonts(page)
  await page.goto(`${APP_URL}?connLost=1`)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)

  const row = page.locator('.conn-row', { hasText: '10.0.1.5' }).first()
  const dot = row.locator('span[title]').first()
  await expect(dot).toHaveAttribute('title', /Connected/)

  await page.getByText('10.0.1.5', { exact: false }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('New Query Console', { exact: true }).first().click()
  await page.waitForTimeout(600)
  await page.locator('.view-lines').first().click()
  await page.keyboard.type('SELECT 1;')
  await page.keyboard.press('F5')
  await page.waitForTimeout(700)

  // Red dot, and the tooltip says why instead of "Connected · N ms".
  await expect(dot).toHaveAttribute('title', /Not connected — .*Connection lost/i)
})

// The Explorer shows the same failure when the dead connection is the selected
// one, and its way back must (a) look like a button and (b) actually rebuild the
// connection. It used to be a bare blue word calling `connect`, which the backend
// treats as a no-op whenever the base socket still answers a ping — so the derived
// per-tab connection stayed dead and the next Execute failed the same way.
test('explorer: the lost-connection state offers a real Retry button that reconnects', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(`${APP_URL}?connLost=1`)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)

  // Select the Postgres connection so the Explorer is showing its tree…
  await page.getByText('10.0.1.5', { exact: false }).first().click()
  await page.waitForTimeout(400)
  await openDatabaseNode(page)
  await expect(page.getByText('public', { exact: true }).first()).toBeVisible()

  // …then let a run discover the connection is gone.
  await page.getByText('10.0.1.5', { exact: false }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('New Query Console', { exact: true }).first().click()
  await page.waitForTimeout(600)
  await page.locator('.view-lines').first().click()
  await page.keyboard.type('SELECT 1;')
  await page.keyboard.press('F5')
  await page.waitForTimeout(800)

  // A real <button> (not a div playing one), with a frame so it reads as clickable.
  const retry = page.getByRole('button', { name: /Retry connection/ })
  await expect(retry).toBeVisible()
  const framed = await retry.evaluate((el) => {
    const cs = getComputedStyle(el)
    return {
      tag: el.tagName,
      border: parseFloat(cs.borderTopWidth),
      bg: cs.backgroundColor !== 'rgba(0, 0, 0, 0)',
    }
  })
  expect(framed.tag).toBe('BUTTON')
  expect(framed.border).toBeGreaterThan(0)
  expect(framed.bg).toBe(true)

  // Clicking it REBUILDS the connection (reconnect = disconnect + drop derived +
  // connect), instead of the no-op `connect` on a base socket that still pings.
  const before = await page.evaluate(() => ({ ...((window as any).__ipcCalls ?? {}) }))
  await retry.click()
  await expect(page.getByRole('button', { name: /Retry connection/ })).toHaveCount(0, {
    timeout: 5_000,
  })
  const after = await page.evaluate(() => ({ ...((window as any).__ipcCalls ?? {}) }))
  expect((after.reconnect ?? 0) - (before.reconnect ?? 0)).toBe(1)

  // Tree is back (re-read over the fresh session) and the editor runs again.
  await openDatabaseNode(page)
  await expect(page.getByText('public', { exact: true }).first()).toBeVisible()
  expect((after.list_schemas ?? 0)).toBeGreaterThan(before.list_schemas ?? 0)
  await page.locator('.view-lines').first().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('SELECT * FROM students;')
  await page.keyboard.press('F5')
  await page.waitForTimeout(700)
  await expect(page.getByText(/Rows 1–\d+ of/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join(String.fromCharCode(10))}`).toEqual([])
})
