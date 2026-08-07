import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

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

  const banner = page.getByTestId('disconnected-banner')
  await expect(banner).toHaveCount(0)

  // Run → the connection turns out to be dead.
  const editor = page.locator('.cm-content').first()
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
  await expect(banner).toHaveCount(0, { timeout: 5_000 })

  // …and the editor runs again (the seam is consumed, one failure only).
  await editor.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('SELECT * FROM students;')
  await page.keyboard.press('F5')
  await page.waitForTimeout(700)
  await expect(page.getByText(/Rows 1–\d+ of/).first()).toBeVisible()
  await expect(banner).toHaveCount(0)

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
  await page.locator('.cm-content').first().click()
  await page.keyboard.type('SELECT 1;')
  await page.keyboard.press('F5')
  await page.waitForTimeout(700)

  // Red dot, and the tooltip says why instead of "Connected · N ms".
  await expect(dot).toHaveAttribute('title', /Not connected — .*Connection lost/i)
})
