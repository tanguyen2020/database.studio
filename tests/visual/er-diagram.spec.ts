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
  await expect(page.locator('.cm-content').first()).toContainText('ADD CONSTRAINT')

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
