import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Kafka topic → "Edit partitions…". Kafka can only ADD partitions: a lower or equal
// count is refused in the dialog (no broker round-trip); a higher one is applied and
// the topic tree shows the new count.
test('kafka: Edit partitions only adds, and the tree shows the new count', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.getByRole('button', { name: /Events Kafka/ }).dblclick()
  const topic = page.getByText('payments', { exact: true }).first()
  await expect(topic).toBeVisible({ timeout: 8000 })
  await expect(page.getByText(/^3 part · /)).toBeVisible()

  await topic.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Edit partitions…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit partitions' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('payments')).toBeVisible()
  const input = dialog.getByLabel('New partition count')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('4') // starts one above the current 3

  // fewer / same → explained, and the action is disabled
  await input.fill('2')
  await expect(dialog.getByTestId('partitions-problem')).toContainText('cannot reduce partitions — this topic has 3')
  await expect(dialog.getByRole('button', { name: 'Add partitions' })).toHaveAttribute('aria-disabled', 'true')
  await input.fill('3')
  await expect(dialog.getByTestId('partitions-problem')).toContainText('already has 3 partitions')

  // quick pick ×2 → 6, the backdrop does not dismiss the dialog
  await dialog.getByRole('button', { name: '×2' }).click()
  await expect(input).toHaveValue('6')
  await expect(dialog.getByText(/Adds 3 partitions \(3 → 6\)/)).toBeVisible()
  await page.mouse.click(8, 8)
  await expect(dialog).toBeVisible()

  await dialog.getByRole('button', { name: 'Add partitions' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText(/^6 part · /)).toBeVisible({ timeout: 5000 })

  // reopening shows the new count as the current one
  await topic.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Edit partitions…' }).click()
  await expect(page.getByRole('dialog', { name: 'Edit partitions' }).getByLabel('New partition count')).toHaveValue('7')
  await page.getByRole('dialog', { name: 'Edit partitions' }).getByRole('button', { name: 'Cancel' }).click()
  expect(errors, errors.join('\n')).toEqual([])
})
