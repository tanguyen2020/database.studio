import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// The Explorer header Refresh must be labeled ("⟳ Refresh", not just an icon) and
// must genuinely re-query the backend for EVERY connection type — dispatching to the
// right reload path (relational schema cache, Kafka/NATS streaming, Redis, Cassandra).

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.[c] ?? 0, cmd)

test('Explorer Refresh: labeled + re-queries per connection type', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  const refresh = page.getByRole('button', { name: 'Refresh', exact: true })

  // ---- relational (Postgres): the header shows the word "Refresh" and re-lists schemas
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await expect(refresh).toBeVisible()
  await expect(refresh).toContainText('Refresh')
  {
    const before = await calls(page, 'list_schemas')
    await refresh.click()
    await page.waitForTimeout(400)
    expect(await calls(page, 'list_schemas')).toBeGreaterThan(before)
  }

  // ---- streaming (Kafka): same button, dispatches to a topic reload
  await page.getByRole('button', { name: /Events Kafka/ }).first().click()
  await page.waitForTimeout(500)
  await expect(refresh).toBeVisible()
  {
    const before = await calls(page, 'kafka_topics')
    await refresh.click()
    await page.waitForTimeout(400)
    expect(await calls(page, 'kafka_topics')).toBeGreaterThan(before)
  }

  // ---- Redis: header Refresh must re-SCAN the keyspace
  await page.getByRole('button', { name: /Cache Redis 10\.0\.1\.7/ }).first().click()
  await page.waitForTimeout(600)
  await expect(refresh).toBeVisible()
  {
    const before = await calls(page, 'redis_scan')
    await refresh.click()
    await page.waitForTimeout(500)
    expect(await calls(page, 'redis_scan')).toBeGreaterThan(before)
  }

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
