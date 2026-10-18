import { copyFileSync, readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

test('ER diagram: nodes + edges + Mermaid/export toolbar', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // select Postgres → Explorer loads → right-click schema → View ER Diagram
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('View ER Diagram').first().click()
  await page.waitForTimeout(700)

  // ER tab + toolbar summary + Mermaid button
  await expect(page.getByRole('tab', { name: /ER · public/ }).first()).toBeVisible()
  await expect(page.getByText(/tables · .* relationships/).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mermaid' }).first()).toBeVisible()
  // table nodes rendered (SvelteFlow) — 'students' + 'enrollments'
  await expect(page.getByText('students').first()).toBeVisible()
  await expect(page.getByText('enrollments').first()).toBeVisible()

  // T20 — create relationship + Save to DB
  await page.getByText('+ Relationship').first().click()
  await page.waitForTimeout(200)
  const selects = page.locator('select')
  await selects.nth(0).selectOption('enrollments')
  await selects.nth(1).selectOption('id')
  await selects.nth(2).selectOption('students')
  await selects.nth(3).selectOption('id')
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/Save to DB/).first()).toBeVisible()
  await page.getByText(/Save to DB/).first().click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('tab', { name: /Add Relationships/ }).first()).toBeVisible()
  await expect(page.locator('.view-lines').first()).toContainText('ADD CONSTRAINT')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('ER diagram: drag from a PK column onto another table creates the relationship', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('View ER Diagram').first().click()
  await page.waitForTimeout(700)

  // Grab the source (right) anchor of students.id and drop onto the MIDDLE of the
  // enrollments node — no precise target dot needed (forgiving drop → enrollments PK).
  // Events are dispatched in-page: this drives xyflow's real mousedown/move/up
  // listeners at real coordinates. (Playwright's high-level page.mouse drag cannot
  // drive xyflow's pointer-capture drag in headless — a known limitation — but a real
  // mouse in the app does, which is exactly what these MouseEvents emulate.)
  const src = page.locator('.svelte-flow__handle.source[data-nodeid="students"][data-handleid="id"]').first()
  const target = page.locator('.svelte-flow__node[data-id="enrollments"]').first()
  await expect(src).toBeVisible()
  await expect(target).toBeVisible()
  const s = await src.boundingBox()
  const t = await target.boundingBox()
  if (!s || !t) throw new Error('missing anchor/target box')

  await page.evaluate(
    ({ sx, sy, tx, ty }) => {
      const h = document.querySelector('.svelte-flow__handle.source[data-nodeid="students"][data-handleid="id"]')
      if (!h) throw new Error('source anchor not found')
      const fire = (el: EventTarget, type: string, x: number, y: number) =>
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window }))
      fire(h, 'mousedown', sx, sy)
      fire(document, 'mousemove', sx + 20, sy + 6)
      fire(document, 'mousemove', (sx + tx) / 2, (sy + ty) / 2)
      fire(document, 'mousemove', tx, ty)
      fire(document, 'mouseup', tx, ty)
    },
    { sx: s.x + s.width / 2, sy: s.y + s.height / 2, tx: t.x + t.width / 2, ty: t.y + t.height / 2 },
  )
  await page.waitForTimeout(300)

  // relationship created (arrow persists) → the unsaved "Save to DB" affordance appears
  await expect(page.getByText(/Save to DB/).first()).toBeVisible()
  // …and it targets the enrollments PK (default anchor for a body drop)
  await expect(page.getByText(/students\.id → enrollments\.id/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('ER diagram: select a table then drag a corner to shrink it', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('View ER Diagram').first().click()
  await page.waitForTimeout(700)

  const node = page.locator('.svelte-flow__node[data-id="students"]').first()
  const before = await node.boundingBox()
  if (!before) throw new Error('no node box')

  // no resize handles until the table is selected
  await expect(page.locator('.svelte-flow__node[data-id="students"] .svelte-flow__resize-control')).toHaveCount(0)
  await node.click({ position: { x: 30, y: 8 } })
  await page.waitForTimeout(200)
  await expect(page.locator('.svelte-flow__node[data-id="students"] .svelte-flow__resize-control.handle.bottom.right').first()).toBeVisible()

  // drag the bottom-right handle inward → the table shrinks (events dispatched in-page,
  // driving xyflow's resize listeners; Playwright's high-level drag can't drive them).
  const h = page.locator('.svelte-flow__node[data-id="students"] .svelte-flow__resize-control.handle.bottom.right').first()
  const hb = await h.boundingBox()
  if (!hb) throw new Error('no handle box')
  await page.evaluate(
    ({ hx, hy }) => {
      const el = document.querySelector('.svelte-flow__node[data-id="students"] .svelte-flow__resize-control.handle.bottom.right')
      if (!el) throw new Error('resize handle not found')
      const fire = (t: EventTarget, type: string, x: number, y: number) =>
        t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window }))
      fire(el, 'mousedown', hx, hy)
      fire(document, 'mousemove', hx - 40, hy - 40)
      fire(document, 'mousemove', hx - 70, hy - 70)
      fire(document, 'mouseup', hx - 70, hy - 70)
    },
    { hx: hb.x + hb.width / 2, hy: hb.y + hb.height / 2 },
  )
  await page.waitForTimeout(300)

  const after = await node.boundingBox()
  if (!after) throw new Error('no node box after')
  expect(after.width).toBeLessThan(before.width - 20)
  expect(after.height).toBeLessThan(before.height - 20)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Relationship lines: orthogonal routes with crow's-foot ends; the column label
// stays hidden at rest (no clutter) and shows when one of the two tables is hovered.
test('ER diagram: quiet lines at rest, labelled when a related table is hovered', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('View ER Diagram').first().click()
  await page.waitForTimeout(700)

  const edges = page.locator('.svelte-flow__edge .er-edge')
  await expect(edges.first()).toBeVisible()
  // each relationship: one route + the two cardinality ends (many / one)
  await expect(edges.first().locator('.er-edge-end')).toHaveCount(2)
  // the route is orthogonal (smooth-step) — no cubic bezier segments
  const d = await edges.first().locator('path.er-edge-path').getAttribute('d')
  expect(d ?? '').not.toMatch(/C/)
  // no label clutter at rest
  await expect(page.locator('.er-edge-label')).toHaveCount(0)
  // hovering a table lights up its relationships and names their columns
  await page.locator('.svelte-flow__node[data-id="enrollments"]').first().hover({ position: { x: 40, y: 10 } })
  await expect(page.locator('.er-edge-label').first()).toBeVisible()
  await expect(page.locator('.er-edge.active').first()).toBeVisible()
  // xyflow's chrome follows the app palette (not a white panel on a dark canvas)
  const bg = await page.locator('.svelte-flow__minimap').first().evaluate((el) => getComputedStyle(el).backgroundColor)
  const surface = await page.evaluate(() => {
    const p = document.createElement('div')
    p.style.background = 'var(--surface)'
    document.body.appendChild(p)
    const c = getComputedStyle(p).backgroundColor
    p.remove()
    return c
  })
  expect(bg).toBe(surface)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// SVG/PNG export draws the diagram the way the canvas shows it (shared edge
// geometry), where the tables are NOW, in the current theme — not straight
// centre-to-centre lines at the positions of the first layout.
test('ER diagram: SVG/PNG export matches the canvas', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.addInitScript(() => localStorage.setItem('theme', 'light'))
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('View ER Diagram').first().click()
  await page.waitForTimeout(900)

  // the canvas route of enrollments.student_id → students.id
  const canvasD = await page.locator('.svelte-flow__edge .er-edge path.er-edge-path').first().getAttribute('d')
  expect(canvasD ?? '').not.toMatch(/C/)

  const [svgDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'SVG', exact: true }).click()])
  expect(svgDl.suggestedFilename()).toBe('er_public.svg')
  const svg = readFileSync((await svgDl.path())!, 'utf8')
  expect(svg.startsWith('<svg')).toBe(true)
  for (const rel of ['enrollments.student_id → students.id', 'enrollments.course_id → courses.id']) {
    const m = new RegExp(`<title>${rel.replace(/\./g, '\\.')}</title><path d="([^"]+)"/><path d="([^"]+)"/><path d="([^"]+)"/>`).exec(svg)
    expect(m, rel).not.toBeNull()
    expect(m![1]).toMatch(/Q/) // rounded orthogonal route
    expect(m![1]).not.toMatch(/C/)
    expect(m![2].match(/M /g)).toHaveLength(4) // crow's foot (3 prongs + bar)
  }
  // light theme colours, not the old hard-coded dark background
  expect(svg).not.toContain('fill="#0f1219"')
  const bg = /<rect width="\d+" height="\d+" fill="(#[0-9a-f]{6})"\/>/.exec(svg)?.[1] ?? ''
  const lum = parseInt(bg.slice(1, 3), 16) + parseInt(bg.slice(3, 5), 16) + parseInt(bg.slice(5, 7), 16)
  expect(lum, `background ${bg}`).toBeGreaterThan(600)

  // drag a table → the export follows it (it used the first layout before)
  const before = /<text x="([\d.]+)" y="([\d.]+)"[^>]*>courses<\/text>/.exec(svg)
  const node = page.locator('.svelte-flow__node[data-id="courses"]').first()
  const nb = await node.boundingBox()
  if (!nb) throw new Error('no node box')
  await page.mouse.move(nb.x + 40, nb.y + 10)
  await page.mouse.down()
  await page.mouse.move(nb.x + 40, nb.y + 200, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const [svgDl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'SVG', exact: true }).click()])
  const svg2 = readFileSync((await svgDl2.path())!, 'utf8')
  const after = /<text x="([\d.]+)" y="([\d.]+)"[^>]*>courses<\/text>/.exec(svg2)
  expect(before && after).toBeTruthy()
  // courses moved down relative to students
  const rel = (s: string) => {
    const c = Number(/<text x="[\d.]+" y="([\d.]+)"[^>]*>courses<\/text>/.exec(s)![1])
    const st = Number(/<text x="[\d.]+" y="([\d.]+)"[^>]*>students<\/text>/.exec(s)![1])
    return c - st
  }
  expect(rel(svg2)).toBeGreaterThan(rel(svg) + 100)

  const [pngDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'PNG', exact: true }).click()])
  expect(pngDl.suggestedFilename()).toBe('er_public.png')
  const png = readFileSync((await pngDl.path())!)
  expect(png.subarray(0, 4).toString('hex')).toBe('89504e47')
  if (process.env.SHOT_DIR) copyFileSync((await pngDl.path())!, `${process.env.SHOT_DIR}/er-export.png`)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
