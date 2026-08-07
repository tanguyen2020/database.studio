import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// The desktop build installs a guard that kills the WebView's own page menu
// (Back/Refresh/Save as/Print/…). Regression covered here: the first version ran in
// the CAPTURE phase and called preventDefault() unconditionally, and bits-ui's
// context-menu trigger starts with `if (e.defaultPrevented) return` — so every app
// menu (Connections rows, Explorer tree) silently stopped opening on desktop while
// the browser build (where the guard is off) stayed green.
//
// `?lockMenu=1` turns the same guard on in the browser build so REAL right-clicks
// exercise it here.

async function open(page: import('@playwright/test').Page) {
  await blockRemoteFonts(page)
  await page.goto(`${APP_URL}?lockMenu=1`)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
}

test('with the WebView menu guard on, the app context menus still open', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await open(page)

  // 1) Connections list row
  await page.getByText('10.0.1.5', { exact: false }).first().click({ button: 'right' })
  await expect(page.getByText('New Query Console', { exact: true }).first()).toBeVisible()
  await page.keyboard.press('Escape')

  // 2) Object Explorer tree (schema → Tables → table row)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(400)
  await page.getByText('students', { exact: true }).first().click({ button: 'right' })
  await expect(page.getByText('Open Data', { exact: true }).first()).toBeVisible()
  await page.keyboard.press('Escape')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('the guard still blocks the WebView menu on plain page content', async ({ page }) => {
  await open(page)
  const prevented = await page.evaluate(() => {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    document.body.dispatchEvent(ev)
    return ev.defaultPrevented
  })
  expect(prevented).toBe(true)
})
