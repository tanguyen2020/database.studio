import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Comprehensive MongoDB UI coverage (demo path). Selecting the connection
// auto-expands its default database, so collections are visible immediately.
// Collection rows are located by their title (avoids colliding with the
// pre-seeded "students" text inside a CodeMirror editor tab).
const MONGO = /Events MongoDB/
const coll = (page: import('@playwright/test').Page, name: string) =>
  page.locator(`div[title^="${name} —"]`).first()

async function openMongo(page: import('@playwright/test').Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: MONGO }).first().click()
  await page.waitForTimeout(700)
}

test('mongo UI: explorer tree + database & collection context menus', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openMongo(page)

  await expect(page.getByText('Explorer').first()).toBeVisible()
  await expect(page.getByText('3 databases').first()).toBeVisible()

  // database context menu
  await page.getByText('app', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(250)
  for (const item of ['New Query', 'Create Collection…', 'Scan Indexes…', 'Refresh']) {
    await expect(page.getByText(item, { exact: true }).first()).toBeVisible()
  }
  await page.keyboard.press('Escape')

  // collection context menu — every document-store action
  await coll(page, 'students').click({ button: 'right' })
  await page.waitForTimeout(250)
  for (const item of [
    'Open Documents',
    'New Query',
    'Import Data…',
    'Export to file…',
    'Copy to…',
    'Create Index…',
    'Show Definition',
    'Rename…',
    'Drop Collection',
  ]) {
    await expect(page.getByText(item, { exact: true }).first()).toBeVisible()
  }
  await page.keyboard.press('Escape')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('mongo UI: document viewer (Open Documents → grid + filter + Export)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openMongo(page)

  await coll(page, 'students').click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.getByText('Open Documents', { exact: true }).first().click()
  await page.waitForTimeout(500)

  await expect(page.getByRole('tab', { name: /app\.students/ }).first()).toBeVisible()
  // Header must make the connection + database unmistakable
  await expect(page.getByTitle('Connection').filter({ hasText: 'Events MongoDB' }).first()).toBeVisible()
  await expect(page.getByTitle(/^Database: app/).first()).toBeVisible()
  await expect(page.getByText('Ann').first()).toBeVisible() // document rendered via mongo_exec
  // footer pager (page-based, consistent with the relational Table Viewer)
  await expect(page.getByText(/of 2 docs/).first()).toBeVisible()
  await expect(page.getByText(/Page 1 of/).first()).toBeVisible()
  await expect(page.getByText('Page size').first()).toBeVisible()
  await expect(page.getByPlaceholder(/filter \(JSON\)/).first()).toBeVisible()

  // number-type columns are colour-tinted (age = int → --syntax-number), text isn't
  const ageColor = await page.getByText('30', { exact: true }).first().evaluate((el) => getComputedStyle(el).color)
  const nameColor = await page.getByText('Ann', { exact: true }).first().evaluate((el) => getComputedStyle(el).color)
  expect(ageColor).not.toBe(nameColor)

  // Export the loaded documents → the shared export wizard opens
  await page.getByText('Export…', { exact: true }).first().click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('dialog').getByText(/Export/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('mongo UI: create index / create collection / rename / drop dialogs', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openMongo(page)

  // Create Index dialog → fill field → Create (runs createIndex on the DB)
  await coll(page, 'students').click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('Create Index…', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/Create index on app\.students/).first()).toBeVisible()
  await page.getByPlaceholder('e.g. email').fill('email')
  await page.getByRole('button', { name: 'Create' }).first().click()
  await page.waitForTimeout(300)
  await expect(page.getByText(/Create index on app\.students/)).toHaveCount(0) // closed after run

  // Create Collection dialog (from the database node)
  await page.getByText('app', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('Create Collection…', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText('Create collection', { exact: true }).first()).toBeVisible()
  await page.getByPlaceholder('e.g. orders').fill('sessions_new')
  await page.getByRole('button', { name: 'OK' }).first().click()
  await page.waitForTimeout(300)
  await expect(page.getByText('Create collection', { exact: true })).toHaveCount(0)

  // Rename dialog
  await coll(page, 'courses').click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('Rename…', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText('Rename collection', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).first().click()

  // Drop Collection → in-app confirm
  await coll(page, 'enrollments').click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('Drop Collection', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText('Drop collection', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Confirm' }).first().click()
  await page.waitForTimeout(300)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('mongo UI: Sessions monitor + Backup dialog', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openMongo(page)

  // Sessions (header) → admin view opens with the mongo view list
  await page.getByText('Sessions', { exact: true }).first().click()
  await page.waitForTimeout(400)
  await expect(page.getByText('Session Monitor').first()).toBeVisible()
  await expect(page.getByText('Server Status').first()).toBeVisible()

  // Backup (header) → backup dialog
  await page.getByText('⤓ Backup', { exact: true }).first().click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('dialog').getByText(/Backup/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('mongo UI: no tab on connect + query editor (via New Query) runs a find', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openMongo(page)

  // opening the MongoDB connection must NOT auto-open a query tab — collections
  // live in the sidebar; a query console is opened explicitly via New Query.
  await expect(page.getByText('Untitled Mongo')).toHaveCount(0)

  await page.getByText('app', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.getByText('New Query', { exact: true }).first().click()
  await page.waitForTimeout(400)
  await expect(page.getByText('Untitled Mongo').first()).toBeVisible()

  await page.locator('.cm-content').first().click()
  await page.keyboard.type('db.students.find({})')
  // the Run button (F5 path) executes mongosh via mongo_exec — same as Ctrl+Enter
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(500)
  await expect(page.getByText('Ann').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('mongo UI: tree rows get a selected highlight on click', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openMongo(page)

  // clicking a database row selects it (highlight) — exactly one selected row
  await page.getByText('app', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.locator('.mrow.sel')).toHaveCount(1)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('mongo UI: Design Document edits fields (add → preview → apply)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openMongo(page)

  await coll(page, 'students').click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.getByText('Design Document…', { exact: true }).first().click()
  await page.waitForTimeout(400)

  const dlg = page.getByRole('dialog', { name: 'Design Document' })
  await expect(dlg).toBeVisible()
  await expect(dlg.getByText(/Fields \(/).first()).toBeVisible()

  // add a field → the generated updateMany appears in the preview
  await dlg.getByText('+ Add field', { exact: true }).click()
  await page.waitForTimeout(150)
  await dlg.getByPlaceholder('field name').fill('active')
  await dlg.getByPlaceholder(/default \(JSON\)/).fill('true')
  await page.waitForTimeout(200)
  await expect(dlg.getByText(/updateMany/).first()).toBeVisible()
  await expect(dlg.getByText(/"\$set": \{ "active": true \}/).first()).toBeVisible()

  // apply → runs the statement(s) via mongo_exec and closes
  await dlg.getByText('Apply', { exact: true }).click()
  await page.waitForTimeout(400)
  await expect(page.getByRole('dialog', { name: 'Design Document' })).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('mongo UI: connection New Database (name + first collection)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openMongo(page)

  await page.getByRole('button', { name: MONGO }).first().click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.getByText('New Database…', { exact: true }).first().click()
  await page.waitForTimeout(300)

  const dlg = page.getByRole('dialog', { name: 'New Database' })
  await expect(dlg).toBeVisible()
  // MongoDB shows a "First collection" field (a DB persists only with a collection)
  await expect(dlg.getByText('First collection').first()).toBeVisible()
  await dlg.getByPlaceholder('new_database').fill('shop')
  await dlg.getByPlaceholder('e.g. items').fill('products')
  await page.waitForTimeout(150)
  await dlg.getByText('Create', { exact: true }).click()
  await page.waitForTimeout(400)
  await expect(page.getByRole('dialog', { name: 'New Database' })).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('mongo UI: query editor suggests collections after "db."', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openMongo(page)

  // open a Mongo query console on the app database
  await page.getByText('app', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.getByText('New Query', { exact: true }).first().click()
  await page.waitForTimeout(400)

  await page.locator('.cm-content').first().click()
  await page.keyboard.type('db.') // kicks off the lazy collection load
  await page.waitForTimeout(700)
  await page.keyboard.type('s') // re-open the popup with collections cached
  await page.waitForTimeout(500)
  const tip = page.locator('.cm-tooltip-autocomplete')
  await expect(tip).toBeVisible({ timeout: 3000 })
  await expect(tip.getByText('students').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('mongo UI: double-click a DB expands; double-click a collection opens documents', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openMongo(page)

  // the default db (app) auto-expands → collections visible
  await expect(coll(page, 'students')).toBeVisible()

  // single-click the DB selects only — it must NOT collapse (collections stay)
  await page.getByText('app', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(coll(page, 'students')).toBeVisible()

  // double-click the DB collapses…
  await page.getByText('app', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await expect(coll(page, 'students')).toHaveCount(0)
  // …and double-click expands again
  await page.getByText('app', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await expect(coll(page, 'students')).toBeVisible()

  // double-click a COLLECTION opens its documents (a Table-Viewer-style tab)
  await coll(page, 'students').dblclick()
  await page.waitForTimeout(500)
  await expect(page.getByRole('tab', { name: /app\.students/ }).first()).toBeVisible()
  await expect(page.getByText('Ann').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('mongo UI: Ctrl+N opens a Mongo query editor bound to the selected database', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openMongo(page)

  // select a specific database (analytics) — single-click publishes it as the
  // selected database, so Ctrl/Cmd+N binds the new console to it
  await page.getByText('analytics', { exact: true }).first().click()
  await page.waitForTimeout(250)

  await page.keyboard.press('Control+n')
  await page.waitForTimeout(500)

  // a MongoDB console opened (titled Mongo, not a generic "Untitled query")
  await expect(page.getByText('Untitled Mongo').first()).toBeVisible()
  await expect(page.getByText('Untitled query')).toHaveCount(0)
  // its Database dropdown reflects the selected database
  await expect(page.getByTitle('Database', { exact: true }).first()).toHaveValue('analytics')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('mongo UI: query editor Database dropdown switches the bound database', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openMongo(page)

  // open a Mongo console via the app db's New Query → dropdown shows a picker
  await page.getByText('app', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.getByText('New Query', { exact: true }).first().click()
  await page.waitForTimeout(400)

  const dbInput = page.getByTitle('Database', { exact: true }).first()
  await expect(dbInput).toBeVisible()
  await dbInput.click()
  await page.waitForTimeout(150)
  await page.getByRole('option', { name: 'analytics', exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(dbInput).toHaveValue('analytics')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('mongo UI: query editor suggests MongoDB methods and operators', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openMongo(page)

  await page.getByText('app', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.getByText('New Query', { exact: true }).first().click()
  await page.waitForTimeout(400)
  await page.locator('.cm-content').first().click()

  // after `db.<coll>.` → collection METHODS (find / aggregate / updateOne…)
  await page.keyboard.type('db.students.')
  await page.waitForTimeout(400)
  const tip = page.locator('.cm-tooltip-autocomplete')
  await expect(tip).toBeVisible({ timeout: 3000 })
  await expect(tip.getByText('find', { exact: true }).first()).toBeVisible()
  await expect(tip.getByText('aggregate', { exact: true }).first()).toBeVisible()
  await page.keyboard.press('Escape')

  // inside a filter, typing `$` → OPERATORS ($gt / $set / $match…)
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.keyboard.type('db.students.find({age:{$g')
  await page.waitForTimeout(400)
  await expect(tip).toBeVisible({ timeout: 3000 })
  await expect(tip.getByText('$gt', { exact: true }).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
