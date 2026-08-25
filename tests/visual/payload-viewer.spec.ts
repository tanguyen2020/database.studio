import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// "View payload as JSON" must never open an empty box. Monaco is loaded on demand,
// so anything that stops it coming up (a chunk that fails, a language registration
// that throws) used to leave the popup blank and a few pixels tall — the viewer's
// ONE job, silently gone. `?noMonaco=…` is the browser-only seam that forces that
// failure so the degraded path is actually exercised.

async function openNatsPayload(page: Page, query: string) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL + query)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  await page.waitForTimeout(400)
  await page.getByText('ORDERS', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('orders.eu', { exact: true }).first().click()
  await page.waitForTimeout(600)
  await page.locator('[title="View payload as JSON"]').first().click()
  await page.waitForTimeout(700)
}

/** What the user actually sees in the popup's viewer box. */
async function seen(page: Page) {
  const box = page.locator('[role="dialog"] .cv-box').first()
  const rect = (await box.boundingBox())!
  return { height: Math.round(rect.height), text: (await box.innerText()).trim() }
}

test('payload viewer degrades to plain text when Monaco cannot load', async ({ page }) => {
  await openNatsPayload(page, '?noMonaco=1')

  // the dialog is there, the payload is readable, and the box is not a dead strip
  await expect(page.getByRole('dialog')).toBeVisible()
  const view = await seen(page)
  expect(view.text, 'payload missing from the viewer').toContain('"id"')
  expect(view.height, `viewer collapsed (${view.height}px)`).toBeGreaterThan(28)

  // …and it is still SYNTAX-COLOURED: the key, the number and the punctuation
  // each take their own --syntax-* colour, exactly as the editor would paint them
  const painted = await page.$$eval('[role="dialog"] .cv-fallback span', (els) =>
    els.map((e) => ({ text: (e.textContent ?? '').trim(), color: getComputedStyle(e).color })),
  )
  const key = painted.find((t) => t.text === '"id"')
  const num = painted.find((t) => /^\d+$/.test(t.text))
  expect(key, 'the JSON key is not painted as its own token').toBeTruthy()
  expect(num, 'the JSON number is not painted as its own token').toBeTruthy()
  expect(key!.color).not.toBe(num!.color)
  const wanted = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement)
    return {
      fn: cs.getPropertyValue('--syntax-function').trim(),
      num: cs.getPropertyValue('--syntax-number').trim(),
    }
  })
  const rgb = async (hex: string) =>
    page.evaluate((h) => {
      const el = document.createElement('span')
      el.style.color = h
      document.body.appendChild(el)
      const c = getComputedStyle(el).color
      el.remove()
      return c
    }, hex)
  expect(key!.color).toBe(await rgb(wanted.fn))
  expect(num!.color).toBe(await rgb(wanted.num))
})

test('a failed Monaco load is not cached — the next viewer gets the real editor', async ({ page }) => {
  // only the FIRST load fails: the JSON popup must still come up with a real editor
  await openNatsPayload(page, '?noMonaco=once')
  // a real Monaco surface (not the fallback <pre>)
  await expect(page.locator('[role="dialog"] .view-lines')).toHaveCount(1)
  await expect(page.locator('[role="dialog"] .view-lines').first()).toContainText('"id"')
  const view = await seen(page)
  expect(view.height).toBeGreaterThan(100)
})

/** Computed styling of the popup's Copy/Close pair. */
async function popupButtons(page: Page) {
  return page.$$eval('[role="dialog"] .pv-btn', (els) =>
    els.map((e) => ({
      text: (e.textContent ?? '').trim(),
      bg: getComputedStyle(e).backgroundColor,
      fg: getComputedStyle(e).color,
      border: getComputedStyle(e).borderColor,
    })),
  )
}

/** rgb() of a CSS variable, resolved in the page. */
async function varColor(page: Page, name: string) {
  return page.evaluate((n) => {
    const el = document.createElement('span')
    el.style.color = getComputedStyle(document.documentElement).getPropertyValue(n).trim()
    document.body.appendChild(el)
    const c = getComputedStyle(el).color
    el.remove()
    return c
  }, name)
}

// The Copy/Close pair used to be neutral grey chips on a light background — they
// read as disabled. Copy is the action (accent + white text), Close is secondary
// but still a real button (raised surface, visible border).
for (const view of [
  {
    name: 'NATS subject payload',
    open: async (page: Page) => {
      await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
      await page.waitForTimeout(400)
      await page.getByText('ORDERS', { exact: true }).first().dblclick()
      await page.waitForTimeout(300)
      await page.getByText('orders.eu', { exact: true }).first().click()
      await page.waitForTimeout(600)
      await page.locator('[title="View payload as JSON"]').first().click()
    },
  },
  {
    name: 'Kafka message value',
    open: async (page: Page) => {
      await page.getByRole('button', { name: /Events Kafka/ }).dblclick()
      await page.waitForTimeout(800)
      await page.getByText('payments', { exact: true }).first().click()
      await page.waitForTimeout(1200)
      await page.locator('[title="View value as JSON"]').first().click()
    },
  },
  {
    name: 'Redis value',
    open: async (page: Page) => {
      await page.getByRole('button', { name: /Cache Redis 10\.0\.1\.7/ }).dblclick()
      await page.waitForTimeout(800)
      await page.getByText('leaderboard').first().click()
      await page.waitForTimeout(600)
      await page.getByTitle('View as JSON').first().click()
    },
  },
]) {
  test(`${view.name}: Copy and Close are coloured buttons, not grey chips`, async ({ page }) => {
    await blockRemoteFonts(page)
    await page.goto(APP_URL)
    await page.waitForSelector('#app > *', { timeout: 15_000 })
    await page.waitForTimeout(400)
    await view.open(page)
    await page.waitForTimeout(600)

    const btns = await popupButtons(page)
    const copy = btns.find((b) => b.text === 'Copy')
    const close = btns.find((b) => b.text === 'Close')
    expect(copy, 'no Copy button in the payload popup').toBeTruthy()
    expect(close, 'no Close button in the payload popup').toBeTruthy()

    // Copy carries the app accent with white text
    expect(copy!.bg).toBe(await varColor(page, '--primary'))
    expect(copy!.fg).toBe('rgb(255, 255, 255)')
    // Close is secondary but visibly bordered, and different from Copy
    expect(close!.bg).not.toBe(copy!.bg)
    expect(close!.border).not.toBe('rgba(0, 0, 0, 0)')
    expect(close!.border).not.toBe(close!.bg)
  })
}
