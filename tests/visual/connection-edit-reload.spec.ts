import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Editing where a connection points (database, host, user…) used to leave the
// Explorer showing the OLD tree: its schema cache was never dropped, so even after
// "Save & Reconnect" — or a later Connect — the tree was the previous target's.
// `window.__demoExtraSchema` stands for "the new target has a different catalog":
// it only shows up if the tree is actually re-read.

async function openPostgres(page: Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await openDatabaseNode(page)
  await expect(page.getByRole('treeitem', { name: /^public/ }).first()).toBeVisible()
}

async function editDatabase(page: Page, to: string) {
  await page.evaluate(() => ((window as unknown as Record<string, string>).__demoExtraSchema = 'after_edit'))
  await page.getByRole('button', { name: /Postgres/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Edit Connection…' }).click()
  const form = page.getByRole('dialog', { name: 'Postgres' })
  await expect(form).toBeVisible()
  const db = await inputWithValue(page, form, 'sis_prod')
  await db.fill(to)
  await form.getByRole('button', { name: 'Connect', exact: true }).click()
}

/** The form input currently holding `value` (bind:value sets the property, not the attribute). */
async function inputWithValue(page: Page, scope: ReturnType<Page['getByRole']>, value: string) {
  const handles = await scope.locator('input').elementHandles()
  for (const h of handles) if ((await h.evaluate((el) => (el as HTMLInputElement).value)) === value) return h
  throw new Error('no input holding ' + value)
}

const extra = (page: Page) => page.getByRole('treeitem', { name: /after_edit/ })

test('Save & Reconnect after editing re-reads the Explorer tree from the new target', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openPostgres(page)
  await editDatabase(page, 'sis_staging')

  const apply = page.getByRole('alertdialog', { name: 'Apply changes' })
  await expect(apply).toBeVisible()
  await apply.getByRole('button', { name: 'Save & Reconnect' }).click()

  await expect(extra(page).first()).toBeVisible({ timeout: 8000 })
  // the tree is still usable and the old schema is still listed alongside
  await expect(page.getByRole('treeitem', { name: /^public/ }).first()).toBeVisible()
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('"Save only" keeps the live tree; the next Connect reads the new target', async ({ page }) => {
  await openPostgres(page)
  await editDatabase(page, 'sis_staging')
  const apply = page.getByRole('alertdialog', { name: 'Apply changes' })
  await apply.getByRole('button', { name: 'Save only' }).click()
  await expect(apply).toHaveCount(0)

  // the old session is still open — its tree stays as it was
  await page.waitForTimeout(600)
  await expect(extra(page)).toHaveCount(0)

  // reopen → the new config's catalog is read, not the cached one
  await page.getByRole('button', { name: /Postgres/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Disconnect' }).click()
  await page.getByRole('button', { name: /Postgres/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open Connection' }).click()
  await openDatabaseNode(page)
  await expect(extra(page).first()).toBeVisible({ timeout: 8000 })
})

test('renaming only (a label) does not throw the tree away', async ({ page }) => {
  await openPostgres(page)
  const before = await page.evaluate(() => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.list_schemas ?? 0)
  await page.getByRole('button', { name: /Postgres/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Edit Connection…' }).click()
  const form = page.getByRole('dialog', { name: 'Postgres' })
  await expect(form).toBeVisible()
  await (await inputWithValue(page, form, 'Postgres')).fill('Postgres main')
  await form.getByRole('button', { name: 'Connect', exact: true }).click()
  // no "Apply changes" prompt and no reconnect for a label change
  await expect(page.getByRole('alertdialog', { name: 'Apply changes' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Postgres main/ }).first()).toBeVisible()
  await page.waitForTimeout(500)
  const after = await page.evaluate(() => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.list_schemas ?? 0)
  expect(after).toBe(before)
  await expect(page.getByRole('treeitem', { name: /^public/ }).first()).toBeVisible()
})
