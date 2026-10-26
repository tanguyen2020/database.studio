import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Valkey = a flavor of the Redis engine (SPEC-VALKEY.md): its own card in the
// picker, its own official logo and sidebar band, and every screen of the Redis
// workspace names the server "Valkey" with Valkey's own version (INFO keeps
// redis_version frozen at 7.2.4). The demo connection is opt-in (`?valkey=1`) so
// every other spec keeps its connection list.

async function open(page: Page, valkey: string | null = '1') {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  const url = new URL(APP_URL)
  if (valkey) url.searchParams.set('valkey', valkey)
  await page.goto(url.toString())
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  return errors
}

const shell = (page: Page) => page.locator('[data-stream-shell="redis"]')
const section = (page: Page, name: RegExp) => shell(page).getByRole('navigation', { name: 'Sections' }).getByRole('button', { name })

test('picker has a Valkey card that opens a Redis-engine form wearing the Valkey brand', async ({ page }) => {
  const errors = await open(page, null)
  await page.getByTitle('New connection').first().click()
  const card = page.locator('.picker-card[title="Valkey"]')
  await expect(card).toBeVisible()
  await expect(card.locator('svg[data-logo="valkey"]')).toBeVisible()
  // the plain Redis card is still there and still Redis
  await expect(page.locator('.picker-card[title="Redis"] svg[data-logo="redis"]')).toBeVisible()
  await page.getByLabel('Search database types').fill('valkey')
  await expect(page.locator('.picker-card')).toHaveCount(1)
  await card.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('.cm-tile svg[data-logo="valkey"]')).toBeVisible()
  await expect(dialog.locator('.cm-subtitle')).toContainText('Valkey')
  await expect(dialog.getByRole('radio', { name: 'Valkey' })).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByRole('radio', { name: 'Redis' })).toHaveAttribute('aria-checked', 'false')
  // a new connection starts on DB index 0 (the picker was blank before)
  await expect(dialog.locator('select').filter({ has: page.locator('option[value="15"]') })).toHaveValue('0')
  // switching to Redis changes the brand in place, keyboard included
  await dialog.getByRole('radio', { name: 'Valkey' }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(dialog.getByRole('radio', { name: 'Redis' })).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByRole('radio', { name: 'Redis' })).toBeFocused()
  await expect(dialog.locator('.cm-tile svg[data-logo="redis"]')).toBeVisible()
  await expect(dialog.locator('.cm-subtitle')).toContainText('Redis')
  expect(errors).toEqual([])
})

test('picking Redis opens the form with Redis already chosen', async ({ page }) => {
  const errors = await open(page, null)
  await page.getByTitle('New connection').first().click()
  await page.locator('.picker-card[title="Redis"]').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('radio', { name: 'Redis' })).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByRole('radio', { name: 'Valkey' })).toHaveAttribute('aria-checked', 'false')
  await dialog.getByRole('radio', { name: 'Valkey' }).click()
  await expect(dialog.locator('.cm-tile svg[data-logo="valkey"]')).toBeVisible()
  expect(errors).toEqual([])
})

test('a Valkey connection gets its own band right after Redis, and its workspace says Valkey', async ({ page }) => {
  const errors = await open(page)
  const band = page.locator('.grp-head', { hasText: 'Valkey' })
  await expect(band.locator('svg[data-logo="valkey"]')).toBeVisible()
  await expect(band.locator('.grp-count')).toHaveText('1')
  await expect(page.locator('.grp-head', { hasText: 'Redis' }).locator('svg[data-logo="redis"]')).toBeVisible()
  const order = await page.locator('.grp-label').allTextContents()
  expect(order.indexOf('Valkey')).toBe(order.indexOf('Redis') + 1)

  await page.getByRole('button', { name: /Session Valkey/ }).dblclick()
  await expect(shell(page)).toBeVisible()
  await expect(shell(page).locator('.sw-logo svg[data-logo="valkey"]')).toBeVisible()
  // Valkey's own version — never the frozen redis_version 7.2.4
  await expect(shell(page)).toContainText('Valkey 8.1.10')
  await expect(shell(page)).not.toContainText('Redis 7.2.4')
  await expect(shell(page).getByRole('grid', { name: 'Keys' }).getByText('leaderboard')).toBeVisible({ timeout: 8000 })
  // the tab and the status bar wear the Valkey logo too
  await expect(page.getByRole('tab', { name: /Session Valkey/ }).locator('svg[data-logo="valkey"]')).toBeVisible()

  await section(page, /Server info/).click()
  await expect(shell(page).getByText('Valkey is running normally')).toBeVisible()
  const server = shell(page).locator('section, div').filter({ hasText: /^Server/ }).first()
  await expect(server).toContainText('Valkey 8.1.10')
  // Mode comes from server_mode on Valkey (it used to be missing)
  await expect(shell(page).getByText('Single server')).toBeVisible()

  await section(page, /Workbench/).click()
  await expect(shell(page).getByText('Run Valkey commands', { exact: true })).toBeVisible()
  await expect(shell(page).getByText('valkey-cli', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('a plain Redis connection still says Redis everywhere', async ({ page }) => {
  const errors = await open(page)
  await page.getByRole('button', { name: /Cache Redis 10\.0\.1\.7/ }).dblclick()
  await expect(shell(page).locator('.sw-logo svg[data-logo="redis"]')).toBeVisible()
  await expect(shell(page)).toContainText('Redis 7.2.4')
  await section(page, /Server info/).click()
  await expect(shell(page).getByText('Redis is running normally')).toBeVisible()
  await expect(shell(page).getByText('Valkey')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a Redis profile whose server turns out to be Valkey moves to the Valkey band on connect', async ({ page }) => {
  const errors = await open(page, 'undetected')
  // not known yet → it sits under Redis, with the Redis logo
  await expect(page.locator('.grp-head', { hasText: 'Valkey' })).toHaveCount(0)
  await expect(page.locator('.grp-head', { hasText: 'Redis' }).locator('.grp-count')).toHaveText('2')
  await page.getByRole('button', { name: /Session Valkey/ }).dblclick()
  // the server says it is Valkey → own band, own logo, without a reload
  const band = page.locator('.grp-head', { hasText: 'Valkey' })
  await expect(band.locator('.grp-count')).toHaveText('1', { timeout: 8000 })
  await expect(page.locator('.grp-head', { hasText: 'Redis' }).locator('.grp-count')).toHaveText('1')
  await expect(shell(page)).toContainText('Valkey 8.1.10')
  expect(errors).toEqual([])
})
