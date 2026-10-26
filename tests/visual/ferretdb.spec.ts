import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// FerretDB and Amazon DocumentDB = flavors of the MongoDB engine
// (SPEC-FERRETDB-DOCUMENTDB.md): their own cards, official logos and sidebar groups;
// the MongoDB screens adapt where the server differs (FerretDB does not enforce roles;
// DocumentDB needs TLS and no retryable writes). Demos are opt-in (`?ferretdb=1`,
// `?documentdb=1`) so every other spec keeps its connection list.

async function open(page: Page, params: Record<string, string> = {}) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  const url = new URL(APP_URL)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  await page.goto(url.toString())
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  return errors
}

test('picker: MongoDB, FerretDB and Amazon DocumentDB cards with their official logos', async ({ page }) => {
  const errors = await open(page)
  await page.getByTitle('New connection').first().click()
  await page.getByLabel('Search database types').fill('mongo')
  const cards = page.locator('.picker-card')
  await expect(cards).toHaveCount(3)
  await expect(page.locator('.picker-card[title="MongoDB"] svg[data-logo="mongodb"]')).toBeVisible()
  await expect(page.locator('.picker-card[title="FerretDB"] svg[data-logo="ferretdb"]')).toBeVisible()
  await expect(page.locator('.picker-card[title="Amazon DocumentDB"] svg[data-logo="documentdb"]')).toBeVisible()
  expect(errors).toEqual([])
})

test('form: three engine cards, arrows go round, DocumentDB turns TLS on and explains', async ({ page }) => {
  const errors = await open(page)
  await page.getByTitle('New connection').first().click()
  await page.locator('.picker-card[title="FerretDB"]').click()
  const dialog = page.getByRole('dialog')
  const radio = (name: string) => dialog.getByRole('radio', { name })
  await expect(radio('FerretDB')).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.locator('.cm-tile svg[data-logo="ferretdb"]')).toBeVisible()
  await expect(dialog.getByRole('switch', { name: 'SSL/TLS' })).toHaveAttribute('aria-checked', 'false')
  await expect(dialog.getByTestId('docdb-hint')).toHaveCount(0)
  // the three cards fit side by side (none spills out of the form)
  const box = await dialog.locator('.cm-flavor').boundingBox()
  const last = await radio('Amazon DocumentDB').boundingBox()
  expect(last!.x + last!.width).toBeLessThanOrEqual(box!.x + box!.width + 1)

  // arrows move round the three
  await radio('FerretDB').focus()
  await page.keyboard.press('ArrowRight')
  await expect(radio('Amazon DocumentDB')).toHaveAttribute('aria-checked', 'true')
  await expect(radio('Amazon DocumentDB')).toBeFocused()
  // DocumentDB always uses TLS — picking it turns TLS on and says what else it needs
  await expect(dialog.getByRole('switch', { name: 'SSL/TLS' })).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByTestId('docdb-hint')).toContainText('global-bundle.pem')
  await expect(dialog.getByTestId('docdb-hint')).toContainText('Retryable writes are turned off')
  await page.keyboard.press('ArrowRight')
  await expect(radio('MongoDB')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(radio('Amazon DocumentDB')).toHaveAttribute('aria-checked', 'true')
  expect(errors).toEqual([])
})

test('sidebar: FerretDB and Amazon DocumentDB groups right after MongoDB', async ({ page }) => {
  const errors = await open(page, { ferretdb: '1', documentdb: '1' })
  const bands = page.locator('.grp-head')
  const labels = (await bands.allInnerTexts()).map((t) => t.split('\n')[0].trim())
  const i = labels.indexOf('MongoDB')
  expect(labels.slice(i, i + 3)).toEqual(['MongoDB', 'FerretDB', 'Amazon DocumentDB'])
  await expect(page.locator('.grp-head svg[data-logo="ferretdb"]')).toBeVisible()
  await expect(page.locator('.grp-head svg[data-logo="documentdb"]')).toBeVisible()
  expect(errors).toEqual([])
})

test('users on FerretDB: no role controls, a clear note, its internal user hidden', async ({ page }) => {
  const errors = await open(page, { ferretdb: '1' })
  await page.getByText('Catalog FerretDB').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Users & Privileges…' }).click()
  await expect(page.getByTestId('ferret-roles-note')).toContainText('FerretDB does not enforce roles')
  const list = page.getByRole('listbox', { name: 'Users' })
  await expect(list).toContainText('app')
  await expect(list).toContainText('reporting')
  await expect(list).not.toContainText('documentdb_bg_worker_role')
  await expect(page.getByRole('tab', { name: 'Roles per Database' })).toHaveCount(0)
  await page.getByRole('tab', { name: 'Access' }).click()
  await expect(page.getByTestId('ferret-access')).toContainText('Full access to every database')
  // creating a user offers no roles to pick
  await page.getByRole('button', { name: 'New user' }).click()
  await expect(page.getByTestId('ferret-create-note')).toBeVisible()
  await expect(page.getByText('Roles on database')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('users on MongoDB keep their roles', async ({ page }) => {
  await open(page)
  await page.getByText('Events MongoDB').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Users & Privileges…' }).click()
  await expect(page.getByRole('tab', { name: 'Roles per Database' })).toBeVisible()
  await expect(page.getByTestId('ferret-roles-note')).toHaveCount(0)
})
