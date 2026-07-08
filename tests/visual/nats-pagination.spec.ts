import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// NATS subject messages are server-paginated newest-first (items: sort desc by
// time, show page N / total, total records). The demo subject retains 250
// messages; each Next fetches the next page from the server (not one big load).
test.use({ timezoneId: 'America/New_York' })

test('nats subject messages: newest-first server pagination + total records', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  await page.waitForTimeout(400)
  await page.getByText('ORDERS', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('orders.eu', { exact: true }).first().click()
  await page.waitForTimeout(400)

  const firstSeq = () => page.locator('tbody tr').first().locator('td').first()
  const rowCount = () => page.locator('[title="Copy full payload"]')

  // page 1 / 3, 250 records; newest first → top row is seq 250, 100 rows
  await expect(page.getByText('Page 1 / 3')).toBeVisible()
  await expect(page.getByText('250 records').first()).toBeVisible()
  await expect(firstSeq()).toHaveText('250')
  await expect(rowCount()).toHaveCount(100)

  // Next → page 2 (older window, seq 51..150) fetched from the server
  await page.getByText('Next ▶').click()
  await page.waitForTimeout(400)
  await expect(page.getByText('Page 2 / 3')).toBeVisible()
  await expect(firstSeq()).toHaveText('150')

  // Next → page 3 (oldest 50: seq 1..50)
  await page.getByText('Next ▶').click()
  await page.waitForTimeout(400)
  await expect(page.getByText('Page 3 / 3')).toBeVisible()
  await expect(firstSeq()).toHaveText('50')
  await expect(rowCount()).toHaveCount(50)

  // Prev → back to page 2
  await page.getByText('◀ Prev').click()
  await page.waitForTimeout(400)
  await expect(page.getByText('Page 2 / 3')).toBeVisible()

  // change page size → resets to the first page with a new page count
  await page.getByRole('combobox').first().selectOption('50')
  await page.waitForTimeout(400)
  await expect(page.getByText('Page 1 / 5')).toBeVisible()
  await expect(firstSeq()).toHaveText('250')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
