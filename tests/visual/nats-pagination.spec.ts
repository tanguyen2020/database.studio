import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// NATS subject messages are server-paginated newest-first BY CURSOR. The demo
// subject retains 250 messages spread SPARSELY over the stream (one every 4th
// sequence, last_seq = 1000) — the realistic shape, since a subject is normally
// just a slice of a busy stream. The point of the cursor paging: every page holds
// a FULL page of real messages (100), not "however many happened to fall inside a
// 100-sequence window", and walking the pages reaches every retained message.
test.use({ timezoneId: 'America/New_York' })

test('nats subject messages: cursor pagination fills every page on a sparse subject', async ({ page }) => {
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
  const rows = () => page.locator('[title="Copy full payload"]')
  const seqs = async () => page.locator('tbody tr td:first-child').allInnerTexts()

  // page 1 / 3 of 250 records; newest first → top row is the subject's last seq
  await expect(page.getByText('Page 1 / 3')).toBeVisible()
  await expect(page.getByText('250 records').first()).toBeVisible()
  await expect(firstSeq()).toHaveText('1000')
  await expect(rows()).toHaveCount(100)
  const p1 = await seqs()

  // Next → the next 100 OLDER messages of the subject. A full page again (the old
  // sequence-window paging showed only ~25 here), and no overlap with page 1.
  await page.getByText('Next ▶').click()
  await page.waitForTimeout(400)
  await expect(page.getByText('Page 2 / 3')).toBeVisible()
  await expect(rows()).toHaveCount(100)
  await expect(firstSeq()).toHaveText('600')
  const p2 = await seqs()
  expect(p1.filter((s) => p2.includes(s)), 'pages must not overlap').toEqual([])

  // Next → last page: the remaining 50
  await page.getByText('Next ▶').click()
  await page.waitForTimeout(400)
  await expect(page.getByText('Page 3 / 3')).toBeVisible()
  await expect(rows()).toHaveCount(50)
  await expect(firstSeq()).toHaveText('200')
  const p3 = await seqs()

  // the three pages together cover every retained message exactly once
  const all = [...p1, ...p2, ...p3]
  expect(all).toHaveLength(250)
  expect(new Set(all).size, 'no duplicates across pages').toBe(250)

  // Prev → back to page 2 (cursor kept, same rows)
  await page.getByText('◀ Prev').click()
  await page.waitForTimeout(400)
  await expect(page.getByText('Page 2 / 3')).toBeVisible()
  expect(await seqs()).toEqual(p2)

  // change page size → back to the newest page with a new page count
  await page.getByRole('combobox').first().selectOption('50')
  await page.waitForTimeout(400)
  await expect(page.getByText('Page 1 / 5')).toBeVisible()
  await expect(firstSeq()).toHaveText('1000')
  await expect(rows()).toHaveCount(50)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
