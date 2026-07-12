import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// MongoDB engine e2e (demo path). Verifies the pieces that are deterministic in
// the harness: the sidebar connection opens the Mongo document-store explorer
// (database → collection tree, NOT a relational SQL tree), the database context
// menu offers the document-store actions, and the query editor runs a mongosh
// find whose documents (Extended JSON _id) render in the result grid via
// mongo_exec. The collection viewer reuses the same mongo_exec + ResultGrid path
// proven by the editor test.
test('mongodb: explorer tree + database context menu', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // select the MongoDB connection → the Mongo explorer renders its databases
  await page.getByRole('button', { name: /Events MongoDB/ }).first().click()
  await page.waitForTimeout(500)
  await expect(page.getByText('Explorer').first()).toBeVisible()
  await expect(page.getByText('3 databases').first()).toBeVisible()

  // database node (from list_databases; current DB = ●)
  await expect(page.getByText('app', { exact: true }).first()).toBeVisible()

  // database context menu = document-store actions
  await page.getByText('app', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(300)
  await expect(page.getByText('Create Collection…', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Scan Indexes…', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('New Query', { exact: true }).first()).toBeVisible()
  await page.keyboard.press('Escape')

  // expand the database → a collection from list_tables appears
  await page.getByText('app', { exact: true }).first().click()
  await page.waitForTimeout(300)
  await expect(page.getByText('students', { exact: true }).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Connecting (double-click) a MongoDB connection opens a mongosh query editor
// (Untitled Mongo), and running a find renders documents through mongo_exec —
// this exercises the results.run mongo branch + Extended JSON rendering.
test('mongodb: query editor runs a find', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Events MongoDB/ }).first().dblclick()
  await page.waitForTimeout(500)
  await expect(page.getByText('Untitled Mongo').first()).toBeVisible()

  await page.locator('.cm-content').first().click()
  await page.keyboard.type('db.students.find({})')
  await page.keyboard.press('Control+Enter')
  await page.waitForTimeout(500)
  await expect(page.getByText('Ann').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
