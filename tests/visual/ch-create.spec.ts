import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// T30 — ClickHouse Create Materialized View / Dictionary: guided form + live DDL
// preview. (DDL builders + validation are unit-tested in sql/clickhouse_ddl.test.ts;
// real creation runs against a CH container in integration.)
test('clickhouse create MV: form → DDL preview', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Analytics ClickHouse/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().click({ button: 'right' })
  await page.getByText('Create Materialized View…').first().click()
  await page.waitForTimeout(300)

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/Create Materialized View/)).toBeVisible()
  await dialog.locator('input').first().fill('mv_events')
  await dialog.locator('textarea').fill('SELECT event_type, count() AS c FROM src GROUP BY event_type')
  await page.waitForTimeout(150)
  await expect(dialog.getByText(/CREATE MATERIALIZED VIEW/)).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
