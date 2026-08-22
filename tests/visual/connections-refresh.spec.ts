import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Refresh in the Connections toolbar must genuinely reopen the connection —
// disconnect + connect (backend `reconnect`) — then drop the cached tree and
// re-read it, so the user sees server-side changes a long-lived session missed.

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.[c] ?? 0,
    cmd,
  )

test('Connections Refresh reconnects the selected connection and reloads its tree', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // a connected connection, with its tree already read once
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(600)

  const refresh = page.getByRole('button', { name: 'Refresh connection' })
  await expect(refresh).toBeVisible()
  await expect(refresh).toHaveAttribute('title', /disconnect, connect again/)

  const before = {
    reconnect: await calls(page, 'reconnect'),
    schemas: await calls(page, 'list_schemas'),
    list: await calls(page, 'list_connections'),
  }
  await refresh.click()
  await page.waitForTimeout(900)

  // reopened the session, re-read the saved profiles, and re-read the tree
  expect(await calls(page, 'reconnect')).toBe(before.reconnect + 1)
  expect(await calls(page, 'list_connections')).toBeGreaterThan(before.list)
  expect(await calls(page, 'list_schemas')).toBeGreaterThan(before.schemas)

  // still usable afterwards: the tree is there and the connection reads connected
  await expect(page.getByText('Explorer', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh connection' })).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('Refresh on a disconnected connection re-reads the list without connecting', async ({ page }) => {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // pick one, then disconnect it
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: /Postgres/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Disconnect/ }).click()
  await page.waitForTimeout(400)

  const before = {
    reconnect: await calls(page, 'reconnect'),
    connect: await calls(page, 'connect'),
    list: await calls(page, 'list_connections'),
  }
  await page.getByRole('button', { name: 'Refresh connection' }).click()
  await page.waitForTimeout(600)

  expect(await calls(page, 'list_connections')).toBeGreaterThan(before.list)
  expect(await calls(page, 'reconnect')).toBe(before.reconnect) // nothing to reopen
  expect(await calls(page, 'connect')).toBe(before.connect) // and it must not connect on its own
})

// The Explorer must be re-read for EVERY connection type, not just relational —
// each system has its own tree source (streaming metadata, Redis keyspace,
// Cassandra keyspaces, Mongo databases), so Refresh has to reach all of them.
const CASES: { pick: RegExp; cmd: string }[] = [
  { pick: /Postgres/, cmd: 'list_schemas' },
  { pick: /MySQL/, cmd: 'list_schemas' },
  { pick: /Events Kafka/, cmd: 'kafka_topics' },
  { pick: /Messaging NATS/, cmd: 'nats_js_streams' },
  { pick: /Cache Redis/, cmd: 'redis_scan' },
  { pick: /Profiles Cassandra/, cmd: 'cassandra_tree' },
  { pick: /Events MongoDB/, cmd: 'list_databases' }, // MongoExplorer re-lists databases
  { pick: /Analytics ClickHouse/, cmd: 'list_schemas' },
]

test('Refresh reloads the Explorer of every connection type', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  for (const c of CASES) {
    await page.getByRole('button', { name: c.pick }).first().click()
    await page.waitForTimeout(700) // let the tree load once
    const before = { tree: await calls(page, c.cmd), reconnect: await calls(page, 'reconnect') }
    await page.getByRole('button', { name: 'Refresh connection' }).click()
    await page.waitForTimeout(900)
    expect(await calls(page, 'reconnect'), `${c.pick} reconnect`).toBe(before.reconnect + 1)
    expect(await calls(page, c.cmd), `${c.pick} → ${c.cmd}`).toBeGreaterThan(before.tree)
  }

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('switching to a connection refreshed earlier does not re-query it', async ({ page }) => {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // refresh Postgres, then go away and come back
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: 'Refresh connection' }).click()
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: /MySQL/ }).first().click()
  await page.waitForTimeout(600)

  const before = await calls(page, 'list_schemas')
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(700)
  // the tree is cached and the stale tick must not trigger another full reload
  expect(await calls(page, 'list_schemas')).toBe(before)
})

// The context-menu Refresh on a connection row must behave like the toolbar one:
// reopen THAT connection (not whatever happens to be selected), reload its Explorer
// tree, and show while it works — it used to only re-read the saved profile list.
test('context-menu Refresh reopens the connection, reloads its tree, shows progress', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  // ?slowConnect makes the handshake last as long as a real one, so the
  // "Refreshing…" state is observable (the demo answers instantly otherwise)
  await page.goto(APP_URL + '?slowConnect=600')
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(800)

  const pg = page.getByRole('button', { name: /Postgres/ }).first()
  await pg.click()
  await page.waitForTimeout(900) // its tree is read once

  // ---- refreshing the connection being viewed: reopen + re-read the tree
  {
    const before = {
      reconnect: await calls(page, 'reconnect'),
      schemas: await calls(page, 'list_schemas'),
    }
    await pg.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Refresh', exact: true }).click()
    await expect(page.getByText('Refreshing…').first()).toBeVisible({ timeout: 3000 })
    await page.waitForTimeout(1400)
    expect(await calls(page, 'reconnect')).toBe(before.reconnect + 1)
    expect(await calls(page, 'list_schemas')).toBeGreaterThan(before.schemas)
    await expect(page.getByText('Refreshing…')).toHaveCount(0)
  }

  // ---- Refresh acts on the ROW's connection, not on the selection: with MySQL
  // selected, refreshing Postgres reopens Postgres, drops its cached tree, and
  // leaves it usable when the user comes back to it
  {
    await page.getByRole('button', { name: /MySQL/ }).first().click()
    await page.waitForTimeout(900)
    const before = {
      reconnect: await calls(page, 'reconnect'),
      schemas: await calls(page, 'list_schemas'),
    }
    await pg.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Refresh', exact: true }).click()
    await page.waitForTimeout(1600)
    expect(await calls(page, 'reconnect')).toBe(before.reconnect + 1) // that row's connection
    expect(await calls(page, 'list_schemas')).toBeGreaterThan(before.schemas) // cache dropped → re-read
    await pg.click()
    await page.waitForTimeout(900)
    await openDatabaseNode(page)
    await expect(page.getByText('public', { exact: true }).first()).toBeVisible() // tree still works
  }

  expect(errors, `page errors: ${errors.join(String.fromCharCode(10))}`).toEqual([])
})
