import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Result Grid keyboard navigation: arrow keys move the selected cell.
async function runQuery(page: Page, sql: string) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.locator('.view-lines').first().click()
  await page.keyboard.type(sql)
  await page.getByRole('button', { name: 'Run' }).first().click()
  await expect(page.getByText(/Rows 1–/).first()).toBeVisible()
}

const sel = (page: Page) =>
  page.evaluate(() => {
    const td = [...document.querySelectorAll<HTMLElement>('[role=grid] td[data-cell]')].find((c) =>
      c.getAttribute('aria-selected') === 'true',
    )
    return td ? `${td.dataset.row}:${td.dataset.col}` : null
  })

test('arrow keys move the selected cell', async ({ page }) => {
  await runQuery(page, 'SELECT * FROM students')
  const first = page.locator('[role=grid] td[data-cell]').first()
  await first.click()
  const start = await sel(page)
  expect(start).toMatch(/^0:/)
  const startCol = start!.split(':')[1]

  await page.keyboard.press('ArrowRight')
  const right = await sel(page)
  expect(right).not.toBe(start)
  expect(right).toMatch(/^0:/)

  await page.keyboard.press('ArrowDown')
  expect(await sel(page)).toBe(`1:${right!.split(':')[1]}`)

  await page.keyboard.press('ArrowLeft')
  expect(await sel(page)).toBe(`1:${startCol}`)

  await page.keyboard.press('ArrowUp')
  expect(await sel(page)).toBe(`0:${startCol}`)
})

test('a row picked in the # column is where arrows continue from', async ({ page }) => {
  await runQuery(page, 'SELECT * FROM students')
  // select a whole row via the # gutter → ArrowDown continues from that row
  await page.locator('[role=grid] tbody tr.grid-row').nth(1).locator('td').first().click()
  await page.keyboard.press('ArrowDown')
  expect(await sel(page)).toMatch(/^2:/)
})

test('arrow navigation scrolls the selected cell into view', async ({ page }) => {
  await runQuery(page, 'SELECT * FROM perf_rows_1000')
  await page.locator('[role=grid] td[data-cell]').first().click()
  // Where the selected cell sits: px below the sticky header / above the bottom edge.
  const place = () =>
    page.evaluate(() => {
      const g = document.querySelector<HTMLElement>('[role=grid]')!
      const td = g.querySelector<HTMLElement>('td[aria-selected="true"]')
      if (!td) return null
      const b = g.getBoundingClientRect()
      const r = td.getBoundingClientRect()
      const head = g.querySelector('thead')!.getBoundingClientRect().height
      return { row: Number(td.dataset.row), top: r.top - b.top - head, bottom: b.top + g.clientHeight - r.bottom }
    })
  const seen: number[] = []
  for (let i = 1; i <= 60; i++) {
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(30)
    const p = await place()
    expect(p, `cell ${i} is drawn`).not.toBeNull()
    expect(p!.row).toBe(i)
    expect(p!.top, `cell ${i} under the header`).toBeGreaterThanOrEqual(-0.5)
    expect(p!.bottom, `cell ${i} above the bottom edge`).toBeGreaterThanOrEqual(-0.5)
    seen.push(Math.round(p!.bottom))
  }
  // Once the cell reaches the bottom edge it stays pinned there — the grid moves
  // one row per key press instead of drifting.
  const pinned = seen.slice(-30)
  expect(new Set(pinned).size, `bottom gap per press: ${pinned.join(',')}`).toBe(1)
  for (let i = 59; i >= 0; i--) {
    await page.keyboard.press('ArrowUp')
    await page.waitForTimeout(30)
    const p = await place()
    expect(p!.row).toBe(i)
    expect(p!.top).toBeGreaterThanOrEqual(-0.5)
    expect(p!.bottom).toBeGreaterThanOrEqual(-0.5)
  }
})

test('after editing a cell, arrows keep moving on the grid', async ({ page }) => {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.getByRole('treeitem', { name: /students/ }).first().dblclick()
  await expect(page.getByRole('button', { name: 'Insert row', exact: true }).first()).toBeVisible({ timeout: 10_000 })

  const cell = page.locator('[role=grid] td[data-cell][data-row="0"]').nth(1)
  await cell.click()
  const col = await cell.getAttribute('data-col')
  await page.keyboard.press('Enter')
  await expect(page.locator('.grid-row input')).toHaveCount(1)
  await page.keyboard.press('Enter') // commit
  await expect(page.locator('.grid-row input')).toHaveCount(0)
  await page.keyboard.press('ArrowDown')
  expect(await sel(page)).toBe(`1:${col}`)

  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape') // cancel
  await expect(page.locator('.grid-row input')).toHaveCount(0)
  await page.keyboard.press('ArrowUp')
  expect(await sel(page)).toBe(`0:${col}`)
})

test('column widths do not change while scrolling', async ({ page }) => {
  await runQuery(page, 'SELECT * FROM varlen_rows_2000')
  // page size "All" so the whole result scrolls in one virtualised list
  await page.getByRole('combobox').filter({ hasText: /All/ }).first().selectOption('0')
  const widths = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[role=grid] thead th')].map((th) => Math.round(th.getBoundingClientRect().width)),
    )
  const first = await widths()
  const grid = page.locator('[role=grid]')
  for (const top of [600, 3000, 12000, 30000, 54000, 0]) {
    await grid.evaluate((el, t) => (el.scrollTop = t), top)
    await page.waitForTimeout(120)
    expect(await widths(), `widths at scrollTop ${top}`).toEqual(first)
  }
  // the long values further down still get a column wide enough to read
  const titleW = first[3]
  expect(titleW).toBeGreaterThan(300)
  // and nothing drawn is cut off, except in a column already at the size cap
  for (const top of [0, 30000]) {
    await grid.evaluate((el, t) => (el.scrollTop = t), top)
    await page.waitForTimeout(120)
    const cut = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[role=grid] td[data-cell]')]
        .filter((td) => td.getBoundingClientRect().width < 400)
        .filter((td) => {
          const span = td.querySelector<HTMLElement>('div > span')
          return !!span && span.scrollWidth > span.clientWidth + 1
        })
        .map((td) => `${td.dataset.row}:${td.dataset.col}`),
    )
    expect(cut, `cut-off cells at ${top}`).toEqual([])
  }
})
