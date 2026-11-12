import { expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openApp } from './helpers'

// Import connections from DBeaver (metadata only, Hướng 1). The dialog reads a
// DBeaver data-sources.json → profiles without passwords → the normal review +
// import path. Parsing is unit-tested (connections/dbeaver.test.ts); this proves
// the source step + file flow + review are wired. Structure matches a real
// DBeaver workspace (keys verified 2026-11-11).
const DBEAVER = JSON.stringify({
  connections: {
    'c-1': {
      provider: 'postgresql',
      driver: 'postgres-jdbc',
      name: 'Imported PG',
      'save-password': true,
      configuration: {
        host: 'pg.example.com',
        port: '5432',
        database: 'orders',
        url: 'jdbc:postgresql://pg.example.com:5432/orders',
        configurationType: 'MANUAL',
        type: 'prod',
      },
    },
    'c-2': {
      provider: 'mysql',
      name: 'Imported MySQL',
      configuration: { host: 'my.example.com', port: '3306', database: 'shop', type: 'dev' },
    },
    'c-3': {
      provider: 'snowflake',
      name: 'Warehouse',
      configuration: { host: 'x', port: '443' },
    },
  },
})

test('imports DBeaver connections as metadata (passwords asked on connect)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openApp(page)

  const dir = mkdtempSync(join(tmpdir(), 'ds-dbeaver-'))
  const file = join(dir, 'data-sources.json')
  writeFileSync(file, DBEAVER)

  await page.getByRole('button', { name: 'Import connections' }).click()
  const dlg = page.getByRole('dialog', { name: 'Import connections' })
  await expect(dlg).toBeVisible()

  // source step → pick DBeaver → file flow
  await dlg.locator('[data-source="dbeaver"]').click()
  await expect(dlg.getByText(/username and password encrypted separately/)).toBeVisible()
  await page.locator('input[aria-label="Connections file"]').setInputFiles(file)

  // review: 2 supported connections, both without a password; the snowflake one skipped
  await expect(dlg.getByText(/2 connections in the file/)).toBeVisible()
  await expect(dlg.getByText(/Warehouse \(unsupported engine \(snowflake\)\)/)).toBeVisible()
  const rows = dlg.locator('.ic-row')
  await expect(rows).toHaveCount(2)
  await expect(dlg.locator('[data-pw="missing"]').first()).toBeVisible()
  await expect(dlg.locator('[data-pw="included"]')).toHaveCount(0)

  await dlg.getByRole('button', { name: /^Import 2 connections/ }).click()
  await expect(dlg.getByText(/2 connections imported/)).toBeVisible()
  await expect(dlg.getByText(/no password yet/)).toBeVisible()
  await dlg.getByRole('button', { name: 'Done' }).click()
  await expect(dlg).toBeHidden()

  // the imported connections are now in the list
  await expect(page.locator('.conn-name', { hasText: 'Imported PG' })).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
