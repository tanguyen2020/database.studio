import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode, previewText } from './helpers'

// Partitions node — expanding a partitioned table (demo: enrollments) shows a
// "Partitions" folder listing its partitions, with a right-click maintenance menu.
test('explorer: partitioned table shows a Partitions node with partitions', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)

  // public → Tables → enrollments (expand its detail)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  // Discoverability: the table's right-click menu exposes a Partitions submenu.
  await page.getByRole('treeitem', { name: /enrollments/ }).first().click({ button: 'right' })
  await page.waitForTimeout(150)
  await expect(page.getByText('Partitions', { exact: true }).first()).toBeVisible()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(100)

  await page.getByRole('treeitem', { name: /enrollments/ }).first().getByRole('button').first().click()
  await page.waitForTimeout(400)

  // Partitions folder appears (enrollments is the demo's partitioned table)
  const partsFolder = page.getByRole('treeitem', { name: /Partitions/ }).first()
  await expect(partsFolder).toBeVisible()

  // Expand it via its chevron → a partition row shows
  await partsFolder.getByRole('button').first().click()
  await page.waitForTimeout(300)
  const part = page.getByRole('treeitem', { name: /enrollments_2024/ }).first()
  await part.scrollIntoViewIfNeeded()
  await expect(part).toBeVisible()

  // Right-click a partition → maintenance menu (Detach / Drop) for Postgres
  await part.click({ button: 'right' })
  await page.waitForTimeout(150)
  await expect(page.getByText('Detach partition').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Add Partition dialog — the table menu's Partitions ▸ Add Partition… opens a
// structured dialog with a live script (not just a raw SQL template).
test('add partition dialog: structured form + live script', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)

  // right-click enrollments → Partitions ▸ → Add Partition…
  await page.getByRole('treeitem', { name: /enrollments/ }).first().click({ button: 'right' })
  await page.waitForTimeout(150)
  await page.getByRole('menuitem', { name: 'Partitions' }).hover()
  await page.waitForTimeout(200)
  await page.getByRole('menuitem', { name: 'Add Partition…' }).click()
  await page.waitForTimeout(300)

  // dialog opens with the table's current partitioning + structured RANGE inputs
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByText('Add Partition · public.enrollments')).toBeVisible()
  await page.getByPlaceholder('enrollments_pN').fill('enrollments_2027')
  await page.getByPlaceholder("'2026-01-01'").fill("'2027-01-01'")
  await page.getByPlaceholder("'2027-01-01'").fill("'2028-01-01'")
  await page.waitForTimeout(200)

  // live script updates inside the dialog
  expect(await previewText(page, 'Partition script')).toContain(
    `PARTITION OF "public"."enrollments" FOR VALUES FROM ('2027-01-01') TO ('2028-01-01')`,
  )

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
