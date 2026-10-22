import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// SPEC-STREAM-SHELL.md §5 — the shared workspace frame of Kafka / RabbitMQ / Redis / NATS:
// one tab per connection, sections, the newcomer explanation that can be hidden, and a
// list that stays quick with thousands of rows (virtual scrolling) and works by keyboard.

async function boot(page: Page, query = '') {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL + query)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  return errors
}
const shell = (page: Page) => page.locator('[data-stream-shell="kafka"]')
const navItem = (page: Page, id: string) => shell(page).locator(`nav[aria-label="Sections"] [data-section="${id}"]`)
const kafkaTabs = (page: Page) => page.getByRole('tab', { name: /Events Kafka$/ })

test('workspace frame: one tab per connection, sections by click and arrow keys, a hideable explanation', async ({ page }) => {
  const errors = await boot(page)
  const conn = page.getByRole('button', { name: /Events Kafka/ })
  await conn.dblclick()
  await expect(shell(page)).toBeVisible()
  await expect(kafkaTabs(page)).toHaveCount(1)

  // every section is one click away and becomes the current one
  for (const id of ['overview', 'brokers', 'topics', 'groups', 'registry']) {
    await navItem(page, id).click()
    await expect(navItem(page, id)).toHaveAttribute('aria-current', 'page')
  }
  // ← / → move between sections from the keyboard
  await navItem(page, 'topics').click()
  await navItem(page, 'topics').press('ArrowRight')
  await expect(navItem(page, 'groups')).toHaveAttribute('aria-current', 'page')
  await expect(navItem(page, 'groups')).toBeFocused()
  await navItem(page, 'groups').press('ArrowLeft')
  await expect(navItem(page, 'topics')).toHaveAttribute('aria-current', 'page')

  // opening the connection again does not add a second tab
  await page.waitForTimeout(700)
  await conn.dblclick()
  await expect(kafkaTabs(page)).toHaveCount(1)

  // the one-line explanation for newcomers hides, and stays hidden after a restart
  const hide = shell(page).getByRole('button', { name: 'Hide this explanation' })
  await expect(hide).toBeVisible()
  await hide.click()
  await expect(hide).toHaveCount(0)
  await page.reload()
  await page.waitForSelector('#app > *')
  await page.getByRole('button', { name: /Events Kafka/ }).dblclick()
  await navItem(page, 'topics').click()
  await expect(shell(page).getByRole('button', { name: 'Hide this explanation' })).toHaveCount(0)
  expect(errors, errors.join('\n')).toEqual([])
})

test('a 5,000-row list scrolls without freezing, paints only what is on screen, and works by keyboard', async ({ page }) => {
  const errors = await boot(page, '?kafkaTopics=5000')
  await page.evaluate(() => {
    const w = window as unknown as { __longest: number }
    w.__longest = 0
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longest = Math.max(w.__longest, e.duration)
    }).observe({ type: 'longtask', buffered: false })
  })
  await page.getByRole('button', { name: /Events Kafka/ }).dblclick()
  await navItem(page, 'topics').click()
  const grid = shell(page).getByRole('grid', { name: 'Topics' })
  await expect(grid).toBeVisible()
  await expect(grid).toHaveAttribute('aria-rowcount', '5003') // 5,002 topics + the header row

  // only the rows on screen are in the page, not all 5,002
  const painted = await grid.locator('tbody tr[aria-rowindex]').count()
  expect(painted, `rows painted: ${painted}`).toBeLessThan(150)

  // scrolling to the end shows the last topic
  const scroller = grid.locator('xpath=..')
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    await scroller.evaluate((el, f) => (el.scrollTop = (el.scrollHeight - el.clientHeight) * f), frac)
    await page.waitForTimeout(120)
  }
  await expect(grid.getByText('topic-04999', { exact: true })).toBeVisible()

  // keyboard: Home → first row, ↓ → next, End → last row (scrolled into view), Enter → its messages
  await grid.focus()
  await page.keyboard.press('Home')
  await expect(grid.locator('tbody tr[aria-selected="true"]')).toContainText('enrollment.events')
  await page.keyboard.press('ArrowDown')
  await expect(grid.locator('tbody tr[aria-selected="true"]')).toContainText('payments')
  await page.keyboard.press('End')
  const last = grid.locator('tbody tr[aria-selected="true"]')
  await expect(last).toContainText('topic-04999')
  await expect(last).toBeInViewport()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-kafka-topic-view="topic-04999"]')).toBeVisible()

  // filtering 5,000 rows is immediate
  const filter = shell(page).getByRole('textbox', { name: 'Filter topics…' })
  await filter.fill('topic-0420')
  await expect(grid.locator('tbody tr[aria-rowindex]')).toHaveCount(10)

  const longest = await page.evaluate(() => (window as unknown as { __longest: number }).__longest)
  expect(longest, `longest main-thread block: ${Math.round(longest)} ms`).toBeLessThan(800)
  expect(errors, errors.join('\n')).toEqual([])
})
