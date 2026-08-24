import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Monaco themes take literal colors, so the editor's palette is BUILT at runtime
// from the app's CSS tokens (see $lib/editor/monaco.defineDsTheme) and rebuilt when
// the light/dark toggle flips the `dark` class. If that wiring breaks, the editor
// keeps the colors of the theme it started in — which is exactly what this pins.

/** Colour a keyword is painted in, and the token it is supposed to come from. */
async function keywordVsToken(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const span = [...document.querySelectorAll('.view-lines span')].find(
      (s) => s.textContent?.trim().toLowerCase() === 'select',
    )
    const probe = document.createElement('span')
    probe.style.cssText = 'position:absolute;left:-9999px;color:var(--syntax-keyword)'
    document.body.appendChild(probe)
    const token = getComputedStyle(probe).color
    probe.remove()
    return { painted: span ? getComputedStyle(span).color : null, token }
  })
}

test('the editor palette follows the app theme, both ways', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(700)

  await page.locator('.view-lines').first().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type('select 1')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  const dark = await keywordVsToken(page)
  expect(dark.painted, 'keyword span not found — highlighting is off').not.toBeNull()
  expect(dark.painted).toBe(dark.token)

  // flip to the other theme: the editor must repaint from the new token values
  await page.getByTitle('Toggle theme').first().click()
  await page.waitForTimeout(600)
  const light = await keywordVsToken(page)
  expect(light.token).not.toBe(dark.token) // the app really switched theme
  expect(light.painted).toBe(light.token)

  // and back
  await page.getByTitle('Toggle theme').first().click()
  await page.waitForTimeout(600)
  const backToDark = await keywordVsToken(page)
  expect(backToDark.painted).toBe(dark.token)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
