import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Headless Chromium hides scrollbars by default; this test is about them.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

// The result grid scrolls more than any other surface; its scrollbar used the
// global thin pill (~4px visible) and was hard to see/grab. It now has its own
// wider bar with a visible track — measured here, not assumed.
test('result grid: scrollbar is wide and visible', async ({ page }) => {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.locator('.view-lines').first().click()
  await page.keyboard.type('SELECT * FROM perf_rows_1000')
  await page.getByRole('button', { name: 'Run' }).first().click()

  const grid = page.locator('[data-tab-pane][data-active="true"] .rg-scroll')
  await expect(grid).toBeVisible()
  await expect.poll(() => grid.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)

  const m = await grid.evaluate((el) => {
    const thumb = getComputedStyle(el, '::-webkit-scrollbar-thumb')
    const track = getComputedStyle(el, '::-webkit-scrollbar-track')
    return {
      // a classic (non-overlay) scrollbar takes layout space: its width is exact
      bar: el.offsetWidth - el.clientWidth - parseFloat(getComputedStyle(el).borderLeftWidth) - parseFloat(getComputedStyle(el).borderRightWidth),
      thumb: thumb.backgroundColor,
      track: track.backgroundColor,
    }
  })
  expect(m.bar, 'vertical scrollbar width').toBe(14)
  expect(m.thumb).not.toBe('rgba(0, 0, 0, 0)')
  expect(m.track).not.toBe('rgba(0, 0, 0, 0)')

  await page.screenshot({ path: 'test-results/result-scrollbar.png' })

  // light theme: the thumb must still differ from its track
  await page.evaluate(() => document.documentElement.classList.remove('dark'))
  const light = await grid.evaluate((el) => [getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor, getComputedStyle(el, '::-webkit-scrollbar-track').backgroundColor])
  expect(light[0]).not.toBe(light[1])
  await page.screenshot({ path: 'test-results/result-scrollbar-light.png' })
})
