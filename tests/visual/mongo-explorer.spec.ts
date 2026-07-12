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
  await expect(page.getByText('Ann').first()).toBeVisible() // document rendered via mongo_exec
  await expect(page.getByText(/docs ·/).first()).toBeVisible() // footer count
  await expect(page.getByPlaceholder(/filter \(JSON\)/).first()).toBeVisible()

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

test('mongo UI: query editor runs a find', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: MONGO }).first().dblclick()
  await page.waitForTimeout(500)
  await expect(page.getByText('Untitled Mongo').first()).toBeVisible()

  await page.locator('.cm-content').first().click()
  await page.keyboard.type('db.students.find({})')
  await page.keyboard.press('Control+Enter')
  await page.waitForTimeout(500)
  await expect(page.getByText('Ann').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
