import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Result panel columns can be resized by dragging the header edge (the request:
// "phải cho phép kéo co dãn giữa các cột"). Drives REAL pointer events — the grid
// uses pointerdown/move/up, not the HTML5 drag API (which WebView2 swallows).
test('result grid: drag a header edge to resize the column', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(200)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(200)
  await page.locator('.view-lines').first().click()
  await page.keyboard.type('SELECT * FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await expect(page.getByText(/Rows 1–3 of 3/).first()).toBeVisible()

  const grid = page.locator('table.mono').first()
  const headers = grid.locator('thead th')
  const first = headers.nth(1) // 0 is the No. gutter
  const second = headers.nth(2)

  const w0 = (await first.boundingBox())!.width
  const nextW0 = (await second.boundingBox())!.width

  // drag the first column's grip 120px to the right
  const grip = first.locator('.col-grip')
  const box = (await grip.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 })
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()

  const w1 = (await first.boundingBox())!.width
  expect(w1).toBeGreaterThan(w0 + 100)
  // the neighbour keeps its width — the drag moves ONE column, it does not reflow
  expect(Math.abs((await second.boundingBox())!.width - nextW0)).toBeLessThan(2)

  // and it can be dragged back narrower
  const box2 = (await grip.boundingBox())!
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2)
  await page.mouse.down()
  await page.mouse.move(box2.x + box2.width / 2 - 90, box2.y + box2.height / 2, { steps: 8 })
  await page.mouse.up()
  const w2 = (await first.boundingBox())!.width
  expect(w2).toBeLessThan(w1 - 70)

  // double-clicking a grip resets every column back to content-sized
  await grip.dblclick()
  const w3 = (await first.boundingBox())!.width
  expect(Math.abs(w3 - w0)).toBeLessThan(2)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Rows stay usable after a resize: cells keep their content, selection still
// works, and the widths reset when a new result arrives (they key to old columns).
test('result grid: resized columns keep working and reset on a new result', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(200)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(200)
  await page.locator('.view-lines').first().click()
  await page.keyboard.type('SELECT * FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await expect(page.getByText(/Rows 1–3 of 3/).first()).toBeVisible()

  const grid = page.locator('table.mono').first()
  const first = grid.locator('thead th').nth(1)
  const w0 = (await first.boundingBox())!.width

  const grip = first.locator('.col-grip')
  const box = (await grip.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 130, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
  expect((await first.boundingBox())!.width).toBeGreaterThan(w0 + 100)

  // data still renders and a cell can still be selected after the freeze
  const cell = grid.locator('tbody td').nth(1)
  await expect(cell).toBeVisible()
  await cell.click()
  await expect(page.getByText(/Rows 1–3 of 3/).first()).toBeVisible()

  // a fresh result drops the widths (its columns are different ones)
  await page.locator('.view-lines').first().click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('SELECT * FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(400)
  const wAfter = (await grid.locator('thead th').nth(1).boundingBox())!.width
  expect(Math.abs(wAfter - w0)).toBeLessThan(2)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
