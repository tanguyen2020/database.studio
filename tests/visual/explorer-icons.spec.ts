import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// The tree draws a database symbol per object kind (a cylinder is a database, a grid
// is a table, a key is an index, a chain is a constraint) and sets names in the UI
// face instead of the monospace one. Both are purely how a row is PAINTED: the row
// geometry — padding, gap, indent step, icon box, row height — has to come out byte
// for byte the same as before, which is what the first test pins.
const row = (page: Page, title: string) => page.locator(`[role="treeitem"][title="${title}"]`).first()

async function openTree(page: Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(600)
  await row(page, 'Tables').dblclick()
  await page.waitForTimeout(500)
  await row(page, 'students').getByRole('button').first().click()
  await page.waitForTimeout(700)
  for (const f of ['Columns', 'Indexes', 'Constraints']) {
    await row(page, f).getByRole('button').first().click()
    await page.waitForTimeout(300)
  }
}

/** Everything about a row that decides where it sits and how big it is. */
const geometry = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[role="treeitem"]')].map((el) => {
      const cs = getComputedStyle(el)
      const spans = el.querySelectorAll(':scope > span')
      return {
        title: el.getAttribute('title'),
        padding: cs.padding,
        gap: cs.gap,
        radius: cs.borderRadius,
        height: Math.round(el.getBoundingClientRect().height),
        chevron: spans[0] ? getComputedStyle(spans[0]).width : null,
        iconBox: spans[1] ? getComputedStyle(spans[1]).width : null,
      }
    }),
  )

test('tree rows keep their exact geometry — only the painting changed', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openTree(page)

  const rows = await geometry(page)
  expect(rows.length).toBeGreaterThan(12)

  for (const r of rows) {
    // 3px top/bottom, 6px sides, and the left pad carries the depth indent
    expect(r.padding, r.title ?? '').toMatch(/^3px 6px(?: 3px \d+px)?$/)
    expect(r.gap, r.title ?? '').toBe('5px')
    expect(r.radius, r.title ?? '').toBe('5px')
    expect(r.chevron, r.title ?? '').toBe('16px')
    expect(r.iconBox, r.title ?? '').toBe('15px')
    // 27px where a chevron sets the line box, 23px for a leaf — the two heights the
    // tree has always had. A font change that moved these would show up here.
    expect([23, 27], `${r.title} height`).toContain(r.height)
  }

  // the indent is 15px per level, from 6px at the root
  const indents = [...new Set(rows.map((r) => r.padding))].map((p) => {
    const m = /3px 6px 3px (\d+)px/.exec(p)
    return m ? Number(m[1]) : 6
  })
  expect(indents.sort((a, b) => a - b)).toEqual([6, 21, 36, 51, 66, 81])

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('each object kind is drawn with its own database symbol', async ({ page }) => {
  await openTree(page)

  const marks: Record<string, string> = {}
  for (const title of ['app', 'public', 'Tables', 'students', 'Columns', 'id', 'Indexes', 'Constraints', 'Views']) {
    const el = row(page, title)
    await expect(el, title).toBeVisible()
    const svg = el.locator(':scope > span').nth(1).locator('svg')
    await expect(svg, `${title} has no drawn mark`).toHaveCount(1)
    marks[title] = (await svg.evaluate((n) => n.outerHTML)).replace(/width="\d+" height="\d+"/, '')
  }

  // a database, a schema, a table, a column, an index and a constraint are six
  // different things, so they are six different drawings
  const distinct = ['app', 'public', 'students', 'id', 'Indexes', 'Constraints', 'Views']
  expect(new Set(distinct.map((k) => marks[k])).size).toBe(distinct.length)
  // a folder carries the mark of what it holds: Columns looks like a column, the
  // Tables folder like a table — that is what makes the section self-evident
  expect(marks.Columns).toBe(marks.id)
  expect(marks.Tables).toBe(marks.students)

  // the partitioned table is still the table mark, plus its badge
  const badged = row(page, 'enrollments').locator('svg[data-badge="partitioned"]')
  await expect(badged).toHaveCount(1)
  await expect(badged).toHaveAttribute('aria-label', 'Partitioned table')
  expect(await badged.evaluate((n) => n.innerHTML)).toContain('rect x="3" y="4"')
})

test('object names read as names, values stay monospace', async ({ page }) => {
  await openTree(page)

  const el = row(page, 'students')
  const name = el.locator(':scope > span').nth(2)
  const meta = el.locator(':scope > span').last()
  await expect(name).toHaveText('students')

  const fonts = await page.evaluate(() => {
    const r = document.querySelector('[role="treeitem"][title="students"]')!
    const spans = r.querySelectorAll(':scope > span')
    const main = getComputedStyle(document.documentElement).getPropertyValue('--font-main').trim()
    return {
      name: getComputedStyle(spans[2]).fontFamily,
      meta: getComputedStyle(spans[spans.length - 1]).fontFamily,
      main,
      size: getComputedStyle(spans[2]).fontSize,
    }
  })
  expect(fonts.name).not.toContain('JetBrains Mono')
  expect(fonts.main).toContain(fonts.name.split(',')[0].replace(/["']/g, ''))
  expect(fonts.meta, 'counts and types stay in the monospace face').toContain('JetBrains Mono')
  expect(fonts.size, 'the name size is unchanged').toBe('12.5px')
  await expect(meta).toContainText('rows')
})
