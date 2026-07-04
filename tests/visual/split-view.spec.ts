import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

test('split view: right-click tab → Split Right opens 2 panes', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(500)

  // ban đầu 1 tab strip → 1 nút "+"
  const plus = page.getByTitle('New SQL tab (Ctrl+T)')
  await expect(plus).toHaveCount(1)

  // right-click tab đang active → context menu → Split Right
  await page.getByRole('tab').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Split Right' }).click()
  await page.waitForTimeout(400)

  // giờ có 2 tab strip → 2 nút "+"
  await expect(plus).toHaveCount(2)
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
