import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, wsSection } from './helpers'

// SPEC-NATS-WORKSPACE.md (W4): a NATS connection opens ONE cluster workspace tab
// (Overview · Streams · Key-value buckets) — NATS has no object tree; everything
// is in the tab, in plain language. KV buckets show keys with versions, a key's history (Updated · Deleted
// · Cleared), "Save as new version", a live "Watch for changes", and confirms that
// state the consequence.

async function openNats(page: Page, query = '') {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL + query)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  await expect(page.locator('[data-stream-shell="nats"]')).toBeVisible({ timeout: 8000 })
  return errors
}

const shell = (page: Page) => page.locator('[data-stream-shell="nats"]')
const workspaceTabs = (page: Page) => page.getByRole('tab', { name: /Messaging NATS$/ }) // the tab's name starts with its engine icon
const nav = (page: Page, label: RegExp) => shell(page).getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: label })

test('nats: connecting opens one workspace on the first stream\'s messages (no object tree); overview says how the server is doing', async ({ page }) => {
  const errors = await openNats(page)
  await expect(workspaceTabs(page)).toHaveCount(1)
  await expect(page.locator('[data-sidebar-panel="explorer"]')).toHaveCount(0)
  await expect(page.locator('[data-conn-tree]')).toHaveCount(0)
  for (const label of [/^Overview/, /^Streams/, /^Key-value buckets/]) await expect(nav(page, label)).toBeVisible()
  const ws = shell(page)
  // a new tab lands where messages are read: Streams, first stream (A→Z), its first subject
  await expect(nav(page, /^Streams/)).toHaveAttribute('aria-current', 'page')
  await expect(ws.getByRole('grid', { name: 'Streams' }).locator('tbody tr[aria-selected="true"]')).toContainText('EVENTS')
  await expect(ws.locator('[data-nats-subject-view="events.>"]')).toBeVisible()

  await wsSection(page, 'overview')
  await expect(ws.getByRole('status')).toContainText('NATS 2.10.14 is running and persistence is on')
  await expect(ws.getByText('Persistence (JetStream)', { exact: true })).toBeVisible()
  await expect(ws.getByText('Enabled', { exact: true })).toBeVisible()
  await expect(ws.getByText('Storage used', { exact: true })).toBeVisible()
  // storage used of the account limit (rule U4), as a meter too
  await expect(ws.getByText(/ of 10 GB$/).first()).toBeVisible()
  await expect(ws.getByRole('meter', { name: 'Disk used' })).toBeVisible()
  // largest streams + buckets panels
  await expect(ws.getByRole('button', { name: 'ORDERS', exact: true })).toBeVisible()
  await expect(ws.getByRole('button', { name: 'config', exact: true })).toBeVisible()
  // no raw API words on the overview
  await expect(ws.getByText(/max_storage|jetstream_api|num_pending/)).toHaveCount(0)

  // the section nav stays in the same tab; clicking the connection again too
  await wsSection(page, 'kv')
  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  await expect(workspaceTabs(page)).toHaveCount(1)
  await expect(nav(page, /^Key-value buckets/)).toHaveAttribute('aria-current', 'page')
  await nav(page, /^Streams/).click()
  await expect(ws.getByRole('grid', { name: 'Streams' })).toBeVisible()
  expect(errors, errors.join('\n')).toEqual([])
})

test('nats: overview says persistence is off and why when JetStream is disabled', async ({ page }) => {
  const errors = await openNats(page, '?natsNoJs=1')
  await wsSection(page, 'overview')
  const ws = shell(page)
  await expect(ws.getByRole('status')).toContainText('Persistence (JetStream) is disabled')
  await expect(ws.getByRole('status')).toContainText('-js')
  await expect(ws.getByText('Disabled', { exact: true })).toBeVisible()
  await nav(page, /^Key-value buckets/).click()
  await expect(ws.getByText('Key-value buckets need persistence (JetStream)')).toBeVisible()
  expect(errors, errors.join('\n')).toEqual([])
})

test('nats: streams table → details in words, embedded subject messages, consumers and a purge confirm with counts', async ({ page }) => {
  const errors = await openNats(page)
  await wsSection(page, 'streams')
  const ws = shell(page)
  const grid = ws.getByRole('grid', { name: 'Streams' })
  // a tree: each stream (level 1), its subjects under it (level 2), A→Z
  const streamRows = grid.locator('tbody tr[data-kind="stream"]')
  await expect(streamRows).toHaveCount(3)
  expect(await grid.locator('tbody tr[data-kind]').evaluateAll((trs) => trs.map((t) => `${t.getAttribute('aria-level')} ${t.querySelector('td')?.textContent?.trim().split(/\s+/)[0]}`))).toEqual([
    '1 EVENTS', '2 events.>', '1 INBOX', '2 _INBOX.>', '1 ORDERS', '2 orders.eu', '2 orders.us',
  ])
  // a stream collapses and opens again from its row
  const orders = streamRows.filter({ hasText: 'ORDERS' })
  await orders.getByRole('button', { name: 'Collapse ORDERS' }).click()
  await expect(orders).toHaveAttribute('aria-expanded', 'false')
  await expect(grid.locator('tbody tr[data-kind="subject"]').filter({ hasText: 'orders.eu' })).toHaveCount(0)
  await orders.getByRole('button', { name: 'Expand ORDERS' }).click()
  await expect(orders).toHaveAttribute('aria-expanded', 'true')
  await orders.click()
  // config in words (rule U3/U4) — the raw keys stay behind Advanced
  await expect(ws.getByText('Keeps messages for 7 days')).toBeVisible()
  await expect(ws.getByText('Stored on disk · 3 copies')).toBeVisible()
  // the stream's first subject (A→Z) shows its messages (cursor paging kept)
  await expect(ws.locator('[data-nats-current-subject]')).toHaveText('orders.eu')
  await expect(ws.getByText(/250 records/).first()).toBeVisible()
  // picking a subject in the tree shows that subject's messages
  const us = grid.locator('tbody tr[data-kind="subject"]').filter({ hasText: 'orders.us' })
  await us.click()
  await expect(us).toHaveAttribute('aria-selected', 'true')
  await expect(ws.locator('[data-nats-current-subject]')).toHaveText('orders.us')
  await expect(ws.locator('[data-nats-subject-view="orders.us"]')).toBeVisible()

  // Consumers in words
  await ws.getByRole('tab', { name: /^Consumers/ }).click()
  const row = ws.locator('tbody tr').filter({ hasText: 'order-processor' })
  await expect(row).toContainText('All messages')
  await expect(row).toContainText('Acknowledges each message')
  await expect(row).toContainText('12')

  // Settings in words; raw config only after Advanced
  await ws.getByRole('tab', { name: 'Settings' }).click()
  await expect(ws.getByText('Drop the oldest messages')).toBeVisible()
  await expect(ws.getByText('max_msgs_per_subject')).toHaveCount(0)
  await ws.getByRole('button', { name: 'Advanced' }).click()
  await expect(ws.getByText('max_msgs_per_subject')).toBeVisible()

  // purge: the dialog states the real count; the button says the verb + number
  await ws.getByRole('button', { name: 'Clear all messages…' }).click()
  const dlg = page.getByRole('alertdialog', { name: 'Clear all messages' })
  await expect(dlg).toContainText('Clear all 1,240 messages from ORDERS?')
  await expect(dlg.getByRole('button', { name: 'Clear 1,240 messages' })).toBeVisible()
  await dlg.getByRole('button', { name: 'Cancel' }).click()
  await expect(dlg).toHaveCount(0)
  expect(errors, errors.join('\n')).toEqual([])
})

test('nats: key-value bucket → keys with versions → history, save as new version, delete key confirm', async ({ page }) => {
  const errors = await openNats(page)
  await wsSection(page, 'kv')
  const ws = shell(page)
  const buckets = ws.getByRole('grid', { name: 'Key-value buckets' })
  await expect(buckets.locator('tbody tr')).toHaveCount(2)
  const sessions = buckets.locator('tbody tr').filter({ hasText: 'sessions' })
  await expect(sessions).toContainText('30 minutes')
  await expect(sessions).toContainText('Stored in memory · 3 copies')
  await buckets.locator('tbody tr').filter({ hasText: 'config' }).click()

  // bucket settings in words + keys with version and "Updated"
  await expect(ws.getByText('Versions kept', { exact: true }).first()).toBeVisible()
  await expect(ws.getByText('10 versions')).toBeVisible()
  const keys = ws.getByRole('grid', { name: 'Keys' })
  const flags = keys.locator('tbody tr').filter({ hasText: 'feature.flags' })
  await expect(flags).toContainText('#7')
  // a deleted key is shown as Deleted, not dropped
  await expect(keys.locator('tbody tr').filter({ hasText: 'legacy.mode' })).toContainText('Deleted')

  await flags.click()
  const versions = ws.getByRole('table', { name: 'Versions' })
  await expect(versions.locator('tbody tr')).toHaveCount(3)
  await expect(versions.locator('tbody tr').first()).toContainText('Current')
  await expect(versions.locator('tbody tr').first()).toContainText('Updated')
  const editor = ws.getByRole('textbox', { name: 'Value' })
  await expect(editor).toHaveValue(/"beta"/)

  // edit → Save as new version → version 8 becomes current, the old one stays in history
  await expect(ws.getByRole('button', { name: 'Save as new version' })).toBeDisabled()
  await editor.fill('{"enabled":false}')
  await ws.getByRole('button', { name: 'Save as new version' }).click()
  await expect(versions.locator('tbody tr')).toHaveCount(4)
  await expect(versions.locator('tbody tr').first()).toContainText('#8')
  await expect(versions.locator('tbody tr').first()).toContainText('Current')

  // "Use this value" puts an earlier version back in the editor
  await versions.locator('tbody tr').nth(1).getByRole('button', { name: 'Use this value' }).click()
  await expect(editor).toHaveValue(/"beta"/)
  await ws.getByRole('button', { name: 'Undo changes' }).click()
  await expect(editor).not.toHaveValue(/"beta"/)

  // delete key: the dialog says what happens; the key reads as Deleted afterwards
  await ws.getByRole('button', { name: 'Delete key…' }).click()
  const dlg = page.getByRole('alertdialog', { name: 'Delete key' })
  await expect(dlg).toContainText('Readers will see feature.flags as deleted')
  await expect(dlg).toContainText('up to 10 versions')
  await dlg.getByRole('button', { name: 'Delete key' }).click()
  await expect(dlg).toHaveCount(0)
  await expect(versions.locator('tbody tr').first()).toContainText('Deleted')

  // clear history: names the number of versions removed
  await ws.getByRole('button', { name: 'Clear history…' }).click()
  const purge = page.getByRole('alertdialog', { name: 'Clear history' })
  await expect(purge.getByRole('button', { name: /^Clear 5 versions$/ })).toBeVisible()
  await purge.getByRole('button', { name: /^Clear 5 versions$/ }).click()
  await expect(versions.locator('tbody tr')).toHaveCount(1)
  await expect(versions.locator('tbody tr').first()).toContainText('Cleared')

  // back to the key list
  await ws.getByRole('button', { name: '← All keys' }).click()
  await expect(ws.getByRole('grid', { name: 'Keys' })).toBeVisible()
  expect(errors, errors.join('\n')).toEqual([])
})

test('nats: watch for changes shows a live indicator and changes made by another client', async ({ page }) => {
  const errors = await openNats(page)
  await wsSection(page, 'kv')
  const ws = shell(page)
  await ws.getByRole('grid', { name: 'Key-value buckets' }).locator('tbody tr').filter({ hasText: 'config' }).click()
  const watch = ws.getByRole('button', { name: /Watch for changes/ })
  await expect(watch).toHaveAttribute('aria-pressed', 'false')
  await watch.click()
  await expect(ws.getByRole('button', { name: 'Watching for changes' })).toHaveAttribute('aria-pressed', 'true')
  const feed = ws.getByRole('region', { name: 'Recent changes' })
  await expect(feed).toContainText('Live')
  await expect(feed).toContainText('Waiting for the next change')

  // another client writes a new key and changes an existing one
  await page.evaluate(() => {
    const put = (window as unknown as { __natsKvDemoPut: (b: string, k: string, v: string) => void }).__natsKvDemoPut
    put('config', 'checkout.enabled', 'true')
    put('config', 'rate.limit', '{"per_minute":900}')
  })
  await expect(feed.locator('li')).toHaveCount(2)
  await expect(feed.locator('li').first()).toContainText('rate.limit')
  await expect(feed.locator('li').first()).toContainText('Updated')
  // the key list follows the change live
  const keys = ws.getByRole('grid', { name: 'Keys' })
  await expect(keys.locator('tbody tr').filter({ hasText: 'checkout.enabled' })).toBeVisible()

  // a change to another bucket is not shown
  await page.evaluate(() => (window as unknown as { __natsKvDemoPut: (b: string, k: string, v: string) => void }).__natsKvDemoPut('sessions', 'user.9', '{}'))
  await page.waitForTimeout(200)
  await expect(feed.locator('li')).toHaveCount(2)

  // toggle off → no longer watching
  await ws.getByRole('button', { name: 'Watching for changes' }).click()
  await expect(ws.getByRole('region', { name: 'Recent changes' })).toHaveCount(0)
  await expect(ws.getByRole('button', { name: 'Watch for changes' })).toHaveAttribute('aria-pressed', 'false')
  expect(errors, errors.join('\n')).toEqual([])
})

test('nats: create bucket dialog summarises the settings; delete bucket states what is lost', async ({ page }) => {
  const errors = await openNats(page)
  await wsSection(page, 'kv')
  const ws = shell(page)
  await ws.getByRole('button', { name: '+ Create bucket' }).first().click()
  const dlg = page.getByRole('dialog', { name: 'Create key-value bucket' })
  await dlg.getByRole('textbox', { name: 'Bucket name' }).fill('config')
  await expect(dlg).toContainText('A bucket with this name already exists.')
  await expect(dlg.getByRole('button', { name: 'Create bucket' })).toBeDisabled()
  await dlg.getByRole('textbox', { name: 'Bucket name' }).fill('carts')
  await dlg.getByRole('spinbutton', { name: 'Versions kept per key' }).fill('3')
  await dlg.getByRole('combobox', { name: 'Keys expire after' }).selectOption('1d')
  await dlg.getByRole('button', { name: 'In memory' }).click()
  await expect(dlg).toContainText('Keeps 3 versions per key · keys expire after 1 day · stored in memory · 1 copy')
  // clicking the backdrop does not close a form
  await page.mouse.click(5, 5)
  await expect(dlg).toBeVisible()
  await dlg.getByRole('button', { name: 'Create bucket' }).click()
  await expect(dlg).toHaveCount(0)
  const buckets = ws.getByRole('grid', { name: 'Key-value buckets' })
  await expect(buckets.locator('tbody tr').filter({ hasText: 'carts' })).toContainText('1 day')

  // carts is selected now: delete states keys + values that go away
  await ws.getByRole('button', { name: 'Delete bucket…' }).click()
  const del = page.getByRole('alertdialog', { name: 'Delete key-value bucket' })
  await expect(del).toContainText('This deletes 0 keys and 0 stored values (earlier versions included) from carts.')
  await del.getByRole('button', { name: 'Delete bucket carts' }).click()
  await expect(buckets.locator('tbody tr').filter({ hasText: 'carts' })).toHaveCount(0)
  expect(errors, errors.join('\n')).toEqual([])
})

// Quick ways to fold the stream → subject tree (the chevron alone is a small target),
// and the parent/child rows read differently: a stream is a band, a subject is tinted.
test('nats: streams fold quickly and streams look different from subjects', async ({ page }) => {
  await openNats(page)
  await wsSection(page, 'streams')
  const grid = shell(page).getByRole('grid', { name: 'Streams' })
  const subjects = grid.locator('tbody tr[data-kind="subject"]')
  const orders = grid.locator('tbody tr[data-kind="stream"]').filter({ hasText: 'ORDERS' })
  await expect(subjects).toHaveCount(4)

  // one button folds every stream, and opens them all again
  await shell(page).getByRole('button', { name: 'Collapse all' }).click()
  await expect(subjects).toHaveCount(0)
  await shell(page).getByRole('button', { name: 'Expand all' }).click()
  await expect(subjects).toHaveCount(4)

  // the "2 subjects" label is a target too
  await orders.getByRole('button', { name: '2 subjects' }).click()
  await expect(orders).toHaveAttribute('aria-expanded', 'false')
  await orders.getByRole('button', { name: '2 subjects' }).click()
  await expect(orders).toHaveAttribute('aria-expanded', 'true')
  // and so is a double-click on the stream. The first click opens the details; the rows
  // must not move under the pointer, or the second click lands on another row. (Pause
  // first: clicks within the double-click interval of the clicks above add up.)
  await page.waitForTimeout(700)
  const before = await orders.boundingBox()
  await orders.locator('.ds-name').dblclick()
  await expect(orders).toHaveAttribute('aria-expanded', 'false')
  expect((await orders.boundingBox())!.y, 'opening the details does not push the table down').toBe(before!.y)
  await orders.locator('.ds-name').dblclick()
  await expect(orders).toHaveAttribute('aria-expanded', 'true')

  // a stream is a tinted band with a bold name; a subject is tinted text on a guide line
  const look = await grid.evaluate((g) => {
    const s = g.querySelector('tbody tr[data-kind="stream"]:not(.sel)') as HTMLElement
    const c = g.querySelector('tbody tr[data-kind="subject"]:not(.sel)') as HTMLElement
    const sub = c.querySelector('.nc-subj') as HTMLElement
    return {
      streamBg: getComputedStyle(s).backgroundColor,
      subjectBg: getComputedStyle(c).backgroundColor,
      streamWeight: Number(getComputedStyle(s.querySelector('.ds-name')!).fontWeight),
      subjectColor: getComputedStyle(sub).color,
      streamColor: getComputedStyle(s.querySelector('.ds-name')!).color,
      guide: getComputedStyle(c.querySelector('td')!).backgroundImage,
      height: s.getBoundingClientRect().height,
    }
  })
  expect(look.streamBg, 'a stream row is a band').not.toBe(look.subjectBg)
  expect(look.streamWeight).toBeGreaterThanOrEqual(600)
  expect(look.subjectColor, 'a subject is tinted, not the stream colour').not.toBe(look.streamColor)
  expect(look.guide, 'a subject hangs off a guide line').toContain('gradient')
  expect(look.height, 'rows are compact').toBeLessThanOrEqual(31)
})

// The name column gets the room (numbers need only a few characters), a long name ends in
// "…" with the full name on hover, and the selected row reads differently from the hovered one.
test('nats: long names get the room and selected is not mistaken for hovered', async ({ page }) => {
  await openNats(page)
  await wsSection(page, 'streams')
  const grid = shell(page).getByRole('grid', { name: 'Streams' })
  await grid.locator('tbody tr[data-kind="stream"]').filter({ hasText: 'ORDERS' }).click() // details open
  const nameCol = await grid.locator('th').first().evaluate((th) => th.getBoundingClientRect().width)
  expect(nameCol, 'the name column keeps at least 280px with the details open').toBeGreaterThanOrEqual(280)

  const r = await grid.evaluate((g) => {
    const row = g.querySelector('tbody tr[data-kind="stream"]') as HTMLElement
    const name = row.querySelector('.ds-name') as HTMLElement
    name.textContent = 'agent_CreditDeductedEvent_processing_requests_for_every_region'
    return { title: name.getAttribute('title') !== null, clipped: name.scrollWidth > name.clientWidth, ellipsis: getComputedStyle(name).textOverflow }
  })
  expect(r.title, 'the full name is one hover away').toBe(true)
  expect(r.clipped && r.ellipsis === 'ellipsis', 'a long name ends in "…" instead of being cut').toBe(true)

  const sel = grid.locator('tbody tr.sel')
  const other = grid.locator('tbody tr[data-kind="subject"]:not(.sel)').first()
  await other.hover()
  const [selBg, hoverBg] = await Promise.all([sel.evaluate((t) => getComputedStyle(t).backgroundColor), other.evaluate((t) => getComputedStyle(t).backgroundColor)])
  expect(selBg, 'selected and hovered rows look different').not.toBe(hoverBg)
})
