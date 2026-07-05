import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// T23 — Admin views: Session Monitor (+Kill), Users, Extensions.

test('admin views: session monitor + kill + users + extensions', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await page.getByTitle('Session Monitor').first().click()
  await page.waitForTimeout(400)

  // Admin tab + session rows + Kill action
  await expect(page.getByRole('tab', { name: /Admin ·/ }).first()).toBeVisible()
  await expect(page.getByText('4821').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Kill', exact: true }).first()).toBeVisible()

  // switch to Users view → role rows
  await page.getByRole('button', { name: 'Users & Privileges' }).first().click()
  await page.waitForTimeout(300)
  await expect(page.getByText('postgres').first()).toBeVisible()

  // Extensions view → plpgsql
  await page.getByRole('button', { name: 'Extensions', exact: true }).first().click()
  await page.waitForTimeout(300)
  await expect(page.getByText('plpgsql').first()).toBeVisible()

  // Kill a session (back to sessions) — demo ok, no error
  await page.getByRole('button', { name: 'Session Monitor' }).first().click()
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: 'Kill', exact: true }).first().click()
  await page.waitForTimeout(300)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('admin views: Redis memory analysis (CE-native)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // select the Redis connection, then open admin → normalizes to Memory view
  await page.getByRole('button', { name: /Cache Redis/ }).first().click()
  await page.waitForTimeout(400)
  await page.getByTitle('Session Monitor').first().click()
  await page.waitForTimeout(400)

  await expect(page.getByRole('button', { name: 'Memory', exact: true }).first()).toBeVisible()
  await expect(page.getByText('used_memory').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
