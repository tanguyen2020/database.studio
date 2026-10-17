import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Middle-click (mouse wheel button) closes a tab. On Windows a middle press over
// the scrollable tab strip starts AUTOSCROLL, which swallows `auxclick` — so the tab
// handles mousedown (blocking autoscroll) + mouseup on the same tab.
test('middle-click closes a tab and never starts autoscroll', async ({ page }) => {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await openDatabaseNode(page)

  // two fresh (clean) query tabs
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  const tabs = page.getByRole('tab')
  const before = await tabs.count()
  const last = tabs.nth(before - 1)
  const prev = tabs.nth(before - 2)
  const lastName = await last.getAttribute('title')

  // record whether the middle press was claimed (autoscroll blocked)
  await page.evaluate(() => {
    const w = window as unknown as { __mid: boolean[] }
    w.__mid = []
    document.addEventListener('mousedown', (e) => e.button === 1 && w.__mid.push(e.defaultPrevented))
  })

  // press on one tab, release on another → nothing closes
  const pb = (await prev.boundingBox())!
  const lb = (await last.boundingBox())!
  await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2, { steps: 4 })
  await page.mouse.up({ button: 'middle' })
  await expect(tabs).toHaveCount(before)

  // a real middle-click on a tab closes exactly that tab
  await last.click({ button: 'middle' })
  await expect(tabs).toHaveCount(before - 1)
  await expect(page.getByRole('tab').filter({ has: page.locator(`[title="${lastName}"]`) })).toHaveCount(0)
  const mid = await page.evaluate(() => (window as unknown as { __mid: boolean[] }).__mid)
  expect(mid.length).toBeGreaterThan(0)
  expect(mid.every(Boolean), 'middle press must be claimed so Windows autoscroll never starts').toBe(true)

  // the pinned Objects tab cannot be closed this way
  await page.getByRole('treeitem', { name: /^public/ }).first().dblclick()
  const objects = page.getByRole('tab', { name: /Objects/ })
  if (await objects.count()) {
    await objects.first().click({ button: 'middle' })
    await expect(objects).toHaveCount(1)
  }
})
