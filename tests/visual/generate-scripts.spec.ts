import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// T15 — Generate Scripts: whole-schema dump (structure). The "Generate" button
// saves a .sql file (native Save dialog in the desktop app; a browser download
// here) with CREATE TABLE + FK ALTERs, showing a progress bar through completion.
// Opened from the schema context menu (the old Explorer toolbar button is gone).

async function openWizard(page: Page, query = '') {
  await blockRemoteFonts(page)
  await page.goto(APP_URL + query)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByRole('treeitem', { name: /public/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Generate Scripts…' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Generate Scripts' })
  await expect(dialog.getByText('Generate Scripts', { exact: true })).toBeVisible()
  await expect(dialog.getByText(/Export .*public/)).toBeVisible()
  await expect(dialog.getByRole('group', { name: 'Tables' })).toBeVisible()
  return dialog
}

test('Generate Scripts (structure) → saves a .sql file with CREATE TABLE + FK ALTER', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const dialog = await openWizard(page)

  const modes = dialog.getByRole('radiogroup', { name: 'Script content' })
  await expect(modes.getByText('Structure only')).toBeVisible()
  await expect(modes.getByText('Data only')).toBeVisible()
  await expect(modes.getByText('Structure + Data')).toBeVisible()
  await expect(modes.getByRole('radio', { name: /Structure only/ })).toBeChecked()
  await expect(dialog.getByText(/\d+ of \d+ selected/)).toBeVisible()

  // item 3 — grouped by object type (Tables/Views/Stored Procedures/Functions/…)
  for (const g of ['Views', 'Stored Procedures', 'Functions']) {
    await expect(dialog.getByRole('group', { name: g })).toBeVisible()
    await expect(dialog.getByRole('group', { name: g }).locator('.gs-pill')).toHaveText(/^\d+ \/ \d+$/)
  }
  // names read as names (UI font), not as code
  const nameFont = await dialog.locator('.gs-name').first().evaluate((el) => getComputedStyle(el).fontFamily)
  expect(nameFont.toLowerCase()).not.toContain('mono')

  // wider popup than before (560px) so long object names read
  const box = await dialog.boundingBox()
  expect(box!.width).toBeGreaterThanOrEqual(700)

  // "Generate" (renamed from "Generate → SQL tab") saves a file → browser download
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Generate', exact: true }).click(),
  ])
  expect(dl.suggestedFilename()).toBe('scripts_public.sql')

  // the generated file contains dependency-ordered DDL
  const fs = await import('node:fs')
  const path = await dl.path()
  const content = fs.readFileSync(path, 'utf8')
  expect(content).toContain('CREATE TABLE')
  expect(content).toContain('ADD CONSTRAINT')

  // progress overlay reached completion
  await expect(page.getByText('Generate complete').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('Generate Scripts: search filters objects and groups expand / collapse', async ({ page }) => {
  const dialog = await openWizard(page)
  const items = dialog.locator('.gs-item')
  const total = await items.count()
  expect(total).toBeGreaterThan(3)

  // collapse Tables → its rows disappear, other groups stay
  const tablesToggle = dialog.getByRole('button', { name: 'Collapse Tables' })
  await expect(tablesToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(dialog.getByRole('checkbox', { name: 'students', exact: true })).toHaveCount(1)
  await tablesToggle.click()
  await expect(dialog.getByRole('button', { name: 'Expand Tables' })).toHaveAttribute('aria-expanded', 'false')
  await expect(dialog.getByRole('checkbox', { name: 'students', exact: true })).toHaveCount(0)
  expect(await items.count()).toBeLessThan(total)

  // Collapse all → no rows; Expand all → every row back
  await dialog.getByRole('button', { name: 'Collapse all' }).click()
  await expect(items).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Expand all' }).click()
  await expect(items).toHaveCount(total)

  // the search box is ONE frame: focus rings the box, never the inner input
  const searchInput = dialog.getByLabel('Search objects')
  await searchInput.click()
  const ring = await searchInput.evaluate((el) => {
    const i = getComputedStyle(el)
    const box = getComputedStyle(el.closest('.gs-search')!)
    return { inner: i.boxShadow, innerBorder: i.borderTopWidth, outer: box.boxShadow }
  })
  expect(ring.inner).toBe('none')
  expect(ring.innerBorder).toBe('0px')
  expect(ring.outer).not.toBe('none')

  // typing must not move the box (the dialog keeps its height as results shrink)
  const y0 = (await searchInput.boundingBox())!.y
  const h0 = (await dialog.boundingBox())!.height

  // search: only matching names, across groups, even inside a collapsed group
  await dialog.getByRole('button', { name: 'Collapse Tables' }).click()
  await searchInput.fill('STUD')
  expect((await searchInput.boundingBox())!.y).toBe(y0)
  expect((await dialog.boundingBox())!.height).toBe(h0)
  await expect(dialog.getByText(/matching/)).toBeVisible()
  const names = await items.allInnerTexts()
  expect(names.length).toBeGreaterThan(0)
  for (const n of names) expect(n.toLowerCase()).toContain('stud')
  await expect(dialog.getByRole('checkbox', { name: 'students', exact: true })).toHaveCount(1)

  // check-all of a group toggles only the matches, not hidden objects
  const before = await dialog.locator('.gs-selcount').innerText()
  const tablesGroup = dialog.getByRole('group', { name: 'Tables' })
  await tablesGroup.locator('input[type=checkbox]').uncheck()
  const after = await dialog.locator('.gs-selcount').innerText()
  const picked = (s: string) => Number(/^([\d,]+) of/.exec(s)![1].replace(/,/g, ''))
  const tableMatches = await dialog.locator('.gs-item', { hasText: /stud/i }).count()
  expect(picked(before) - picked(after)).toBeGreaterThan(0)
  expect(picked(before) - picked(after)).toBeLessThanOrEqual(tableMatches)

  // no hit → says so; Escape clears the search without closing the dialog
  await dialog.getByLabel('Search objects').fill('zzz_no_such_object')
  await expect(dialog.getByText(/No object matches/)).toBeVisible()
  await dialog.getByLabel('Search objects').press('Escape')
  await expect(dialog.getByLabel('Search objects')).toHaveValue('')
  await expect(dialog).toBeVisible()
})

test('Generate Scripts: the progress box keeps a fixed width while names change', async ({ page }) => {
  const dialog = await openWizard(page)
  const widths: number[] = []
  await page.exposeFunction('__gsWidth', (w: number) => widths.push(w))
  // sample the progress box width on every DOM change while it runs
  await page.evaluate(() => {
    const obs = new MutationObserver(() => {
      const el = document.querySelector('.gs-prog') as HTMLElement | null
      if (el) (window as unknown as { __gsWidth: (w: number) => void }).__gsWidth(el.getBoundingClientRect().width)
    })
    obs.observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Generate', exact: true }).click()])
  await expect(page.getByText('Generate complete').first()).toBeVisible()
  expect(widths.length).toBeGreaterThan(0)
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1)
  expect(Math.min(...widths)).toBeGreaterThanOrEqual(500)
})

// Stop: a running generation can be halted — nothing new starts, no file is
// written, and the wizard stays open to run again. The slowIntrospect seam makes each
// table's column lookup take 300 ms so there is a run to stop.
test('Generate Scripts: Stop halts the run and writes no file', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const dialog = await openWizard(page, '?slowIntrospect=300')
  let downloads = 0
  page.on('download', () => downloads++)

  await dialog.getByRole('button', { name: 'Generate', exact: true }).click()
  const progress = page.getByRole('dialog', { name: 'Generate progress' })
  await expect(progress.getByText('Generating scripts…')).toBeVisible()
  const stopBtn = progress.getByRole('button', { name: 'Stop' })
  await expect(stopBtn).toBeVisible()
  await stopBtn.click()

  await expect(progress.getByText('Generate stopped')).toBeVisible({ timeout: 5000 })
  await expect(progress.getByText('stopped — no file written')).toBeVisible()
  const [done, total] = (await progress.locator('.gs-count').innerText()).split('/').map((x) => Number(x.trim()))
  expect(done).toBeLessThan(total)
  await expect(progress.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  // the run list shows where it stopped: nothing left running, the rest not run
  const rows = progress.getByRole('list', { name: 'Generate objects' }).getByRole('listitem')
  await expect(rows).toHaveCount(total)
  await expect(rows.and(page.locator('[data-status="running"]'))).toHaveCount(0)
  expect(await rows.and(page.locator('[data-status="pending"]')).count()).toBeGreaterThan(0)
  // wait past where a full run would have finished — still no file
  await page.waitForTimeout(2500)
  expect(downloads).toBe(0)
  await expect(page.getByText('Generate complete')).toHaveCount(0)

  // Close → back on the wizard, which can run again
  await progress.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(progress).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Generate', exact: true })).toBeVisible()
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('Generate Scripts: Escape stops a running generation', async ({ page }) => {
  const dialog = await openWizard(page, '?slowIntrospect=300')
  let downloads = 0
  page.on('download', () => downloads++)
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click()
  const progress = page.getByRole('dialog', { name: 'Generate progress' })
  await expect(progress.getByText('Generating scripts…')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(progress.getByText('Generate stopped')).toBeVisible({ timeout: 5000 })
  // the wizard underneath did NOT close on that Escape
  await expect(dialog).toBeVisible()
  await page.waitForTimeout(2500)
  expect(downloads).toBe(0)
})

// The progress popup lists every object of the run with its status, so you can
// follow which table is being scripted right now and what is still waiting.
test('Generate Scripts: the progress popup tracks which object is running', async ({ page }) => {
  const dialog = await openWizard(page, '?slowIntrospect=300')
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click()
  const progress = page.getByRole('dialog', { name: 'Generate progress' })
  const list = progress.getByRole('list', { name: 'Generate objects' })
  const rows = list.getByRole('listitem')
  const total = Number((await progress.locator('.gs-count').innerText()).split('/')[1].trim())
  await expect(rows).toHaveCount(total)

  // a table is running: its row is marked, named in the status line, and in view
  const running = rows.and(page.locator('[data-status="running"]')).first()
  await expect(running).toBeVisible()
  const name = (await running.locator('.gs-rname').innerText()).trim()
  await expect(progress.getByTestId('gs-current')).toContainText(name)
  const lb = (await list.boundingBox())!
  const rb = (await running.boundingBox())!
  expect(rb.y).toBeGreaterThanOrEqual(lb.y - 1)
  expect(rb.y + rb.height).toBeLessThanOrEqual(lb.y + lb.height + 1)
  // waiting rows exist while it runs; finished ones are ticked with a duration
  expect(await rows.and(page.locator('[data-status="pending"]')).count()).toBeGreaterThan(0)
  await expect(rows.and(page.locator('[data-status="done"]')).first()).toContainText('ms', { timeout: 5000 })

  // the popup keeps its size while the list fills in
  const box0 = (await progress.boundingBox())!
  await expect(progress.getByText('Generate complete')).toBeVisible({ timeout: 15_000 })
  const box1 = (await progress.boundingBox())!
  expect(box1.width).toBe(box0.width)
  expect(box1.height).toBe(box0.height)
  // every structure-mode object ends up done
  await expect(rows.and(page.locator('[data-status="done"]'))).toHaveCount(total)

  // the popup stays up to be read (it used to vanish ~1 s after finishing)…
  await page.waitForTimeout(2000)
  await expect(progress).toBeVisible()
  // …and Close after a successful run closes the wizard as well
  await progress.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(progress).toHaveCount(0)
  await expect(dialog).toHaveCount(0)
})

// The object list is keyboard-driven: one focus stop with an active row.
// ↑/↓ move, Enter/Space check or uncheck, ←/→ collapse/expand a group,
// ↓ from the search box drops into the list; clicking a row makes it active.
test('Generate Scripts: select objects with the keyboard', async ({ page }) => {
  const dialog = await openWizard(page)
  const list = dialog.getByRole('listbox', { name: 'Objects' })
  const active = list.locator('.active')
  const box = (name: string) => dialog.getByRole('checkbox', { name, exact: true })

  // click a row → it becomes the active one and the list has focus
  await dialog.locator('.gs-item', { hasText: 'students' }).first().click({ position: { x: 200, y: 10 } })
  await expect(list).toBeFocused()
  await expect(active).toHaveCount(1)
  await expect(active).toContainText('students')
  // (that click toggled it like any checkbox row)
  await expect(box('students')).not.toBeChecked()

  // ↓ moves to the next object; Enter unchecks it, Enter again re-checks
  await page.keyboard.press('ArrowDown')
  await expect(active).toContainText('courses')
  await expect(box('courses')).toBeChecked()
  await page.keyboard.press('Enter')
  await expect(box('courses')).not.toBeChecked()
  await page.keyboard.press('Space')
  await expect(box('courses')).toBeChecked()
  // ↑ goes back
  await page.keyboard.press('ArrowUp')
  await expect(active).toContainText('students')

  // Home = the first row (the Tables group header); Space toggles the whole group
  await page.keyboard.press('Home')
  await expect(active).toHaveAttribute('aria-label', 'Tables')
  await page.keyboard.press('Space')
  await expect(dialog.getByRole('group', { name: 'Tables' }).locator('input[type=checkbox]')).toBeChecked()
  await page.keyboard.press('Space')
  await expect(dialog.getByRole('group', { name: 'Tables' }).locator('input[type=checkbox]')).not.toBeChecked()
  // ← collapses the group, → expands it again
  await page.keyboard.press('ArrowLeft')
  await expect(box('courses')).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect(box('courses')).toHaveCount(1)
  // ← on an object jumps to its group header
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowLeft')
  await expect(active).toHaveAttribute('aria-label', 'Tables')

  // End = the last row; the active row is scrolled into view
  await page.keyboard.press('End')
  const lb = (await list.boundingBox())!
  const ab = (await active.boundingBox())!
  expect(ab.y + ab.height).toBeLessThanOrEqual(lb.y + lb.height + 1)
  expect(ab.y).toBeGreaterThanOrEqual(lb.y - 1)

  // ↓ in the search box hands over to the list, on the first match
  await dialog.getByLabel('Search objects').fill('vw_')
  await page.keyboard.press('ArrowDown')
  await expect(list).toBeFocused()
  await expect(active).toContainText('vw_active_students')
  // keys never leak out and close the wizard
  await expect(dialog).toBeVisible()
})

// 1,500 tables, instant server: the UI's own cost. Was 56 s (the follow-scroll
// re-laid out the whole run list for every object, and the counters re-scanned
// every row) — now a couple of seconds, with no long main-thread freeze.
test('Generate Scripts: 1,500 tables run fast and never freeze the window', async ({ page }) => {
  test.setTimeout(120_000)
  await page.addInitScript(() => {
    const w = window as unknown as { __lt: number[] }
    w.__lt = []
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__lt.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: true })
  })
  const dialog = await openWizard(page, '?bigSchema=1500')
  await expect(dialog.getByRole('group', { name: 'Tables' }).locator('.gs-pill')).toHaveText(/\/ 1500/, { timeout: 30_000 })
  await page.evaluate(() => ((window as unknown as { __lt: number[] }).__lt = []))
  const t0 = Date.now()
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), dialog.getByRole('button', { name: 'Generate', exact: true }).click()])
  const ms = Date.now() - t0
  const longest = await page.evaluate(() => Math.max(0, ...(window as unknown as { __lt: number[] }).__lt))
  expect(ms, `1,500 tables took ${ms} ms`).toBeLessThan(15_000)
  expect(longest, `a ${longest} ms main-thread task froze the window`).toBeLessThan(1_000)
  // every table made it into the file
  const fs = await import('node:fs')
  const content = fs.readFileSync((await dl.path())!, 'utf8')
  expect(content.match(/CREATE TABLE/g)?.length).toBe(1500)
  const progress = page.getByRole('dialog', { name: 'Generate progress' })
  expect(await progress.locator('[data-status="done"]').count()).toBeGreaterThanOrEqual(1500)
  await expect(progress.locator('[role="listitem"]:not([data-status="done"])')).toHaveCount(0)
})

// Generate Scripts used to read through the profile's MAIN connection. A connection
// runs one call at a time and an introspection call cannot be interrupted, so a slow
// catalog query kept that connection busy long after Cancel and everything else on
// it (Explorer, Open Data…) queued behind it — the app looked frozen. The dialog now
// works on a connection of its own and lets it go on Cancel.
test('Generate Scripts: reads through its own connection and releases it on Cancel', async ({ page }) => {
  const dialog = await openWizard(page)
  const conns = (cmd: string) =>
    page.evaluate((c) => (window as unknown as { __ipcConns?: Record<string, string[]> }).__ipcConns?.[c] ?? [], cmd)

  // ONE call for the whole list (names only — no row counts / sizes / routine
  // parameters), on the dialog's own connection
  const listed = await conns('list_object_names')
  expect(listed, 'the object list is one call').toHaveLength(1)
  expect(listed[0], 'the object list is read on the dialog connection').toContain('#tab-scripts-')
  expect(await conns('close_tab_connection')).not.toContain(listed[0])

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => conns('close_tab_connection')).toContain(listed[0])
})

// A call that never comes back (a slow server) must not trap the user: Stop finishes
// the run at once instead of waiting for it behind a modal popup.
test('Generate Scripts: Stop does not wait for a call that never comes back', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const dialog = await openWizard(page, '?hangIntrospect=1')
  const conns = (cmd: string) =>
    page.evaluate((c) => (window as unknown as { __ipcConns?: Record<string, string[]> }).__ipcConns?.[c] ?? [], cmd)
  let downloads = 0
  page.on('download', () => downloads++)

  await dialog.getByRole('button', { name: 'Generate', exact: true }).click()
  const progress = page.getByRole('dialog', { name: 'Generate progress' })
  const rows = progress.getByRole('list', { name: 'Generate objects' }).getByRole('listitem')
  // a table is stuck on its column list
  await expect(rows.and(page.locator('[data-status="running"]')).first()).toBeVisible()
  const stuckOn = (await conns('list_columns')).at(-1) ?? ''
  expect(stuckOn).toContain('#tab-scripts-')

  const t0 = Date.now()
  await progress.getByRole('button', { name: 'Stop' }).click()
  await expect(progress.getByText('Generate stopped')).toBeVisible({ timeout: 2000 })
  expect(Date.now() - t0, 'Stop must not wait for the hung call').toBeLessThan(2000)
  await expect(rows.and(page.locator('[data-status="running"]'))).toHaveCount(0)
  // the busy connection is let go
  await expect.poll(() => conns('close_tab_connection')).toContain(stuckOn)

  // back on the wizard, which works again — on a FRESH connection
  await progress.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(progress).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click()
  await expect(rows.and(page.locator('[data-status="running"]')).first()).toBeVisible()
  const second = (await conns('list_columns')).at(-1) ?? ''
  expect(second).toContain('#tab-scripts-')
  expect(second).not.toBe(stuckOn)
  await progress.getByRole('button', { name: 'Stop' }).click()
  await progress.getByRole('button', { name: 'Close', exact: true }).click()

  // and the rest of the app is usable: close the wizard, the Explorer answers
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('treeitem', { name: /public/ }).first().click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Generate Scripts…' }).first()).toBeVisible()
  await page.keyboard.press('Escape')

  await page.waitForTimeout(1000)
  expect(downloads).toBe(0)
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
