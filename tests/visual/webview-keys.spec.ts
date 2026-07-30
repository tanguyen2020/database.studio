import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// The release desktop build blocks the WebView's own chrome shortcuts (Ctrl+R / F5
// reload, Ctrl+S save-as, Ctrl+P print, Ctrl+U view-source, F12 devtools) — a reload
// would throw away the open tabs. `?lockKeys=1` turns the same guard on in the
// browser build so it can be exercised here with REAL key events.
//
// Critical property: the guard only calls preventDefault(), so app shortcuts that
// share a key (F5 = Run query) must keep working.

async function open(page: import('@playwright/test').Page, url: string) {
  await blockRemoteFonts(page)
  await page.goto(url)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
}

/** Record `defaultPrevented` as seen AFTER the guard: the guard listens on window in
 *  the bubble phase and was registered first, so a listener added here runs later. */
async function watchKeys(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    ;(window as unknown as { __keys: [string, boolean][] }).__keys = []
    window.addEventListener('keydown', (e) => {
      ;(window as unknown as { __keys: [string, boolean][] }).__keys.push([e.key, e.defaultPrevented])
    })
  })
}

async function prevented(page: import('@playwright/test').Page, key: string) {
  const keys = await page.evaluate(() => (window as unknown as { __keys: [string, boolean][] }).__keys)
  const hit = keys.filter(([k]) => k.toLowerCase() === key.toLowerCase())
  expect(hit.length, `no keydown recorded for ${key}`).toBeGreaterThan(0)
  return hit.every(([, dp]) => dp)
}

test('release guard blocks browser chrome keys, dev build does not', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))

  // guard ON (release behaviour)
  await open(page, `${APP_URL}?lockKeys=1`)
  await watchKeys(page)
  await page.keyboard.press('Control+r')
  await page.keyboard.press('Control+s')
  await page.keyboard.press('Control+u')
  await page.keyboard.press('F12')
  await page.waitForTimeout(200)
  expect(await prevented(page, 'r')).toBe(true)
  expect(await prevented(page, 's')).toBe(true)
  expect(await prevented(page, 'u')).toBe(true)
  expect(await prevented(page, 'F12')).toBe(true)

  // guard OFF (dev build keeps Ctrl+R for the dev loop)
  await open(page, APP_URL)
  await watchKeys(page)
  await page.keyboard.press('Control+r')
  await page.waitForTimeout(200)
  expect(await prevented(page, 'r')).toBe(false)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('with the guard on, F5 still runs the query in the editor', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))

  await open(page, `${APP_URL}?lockKeys=1`)
  // a query console on the Postgres connection
  await page.getByText('10.0.1.5', { exact: false }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('New Query Console', { exact: true }).first().click()
  await page.waitForTimeout(700)

  await page.locator('.cm-content').first().click()
  await page.keyboard.type('SELECT * FROM students')
  await page.keyboard.press('F5')
  await page.waitForTimeout(900)

  // the result panel appeared → the editor's Run keymap survived the guard
  await expect(page.getByText(/Rows 1–3 of 3/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
