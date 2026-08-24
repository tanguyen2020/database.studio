import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Settings → Editor used to be dead UI: nothing read font size / tab size / word
// wrap / autocomplete delay (the CodeMirror editor ignored them too). They now
// drive the editor, and live — without reopening the tab.

type Ed = { getModel: () => { getOptions: () => { tabSize: number } } | null }

/** What the live editor is actually running with (model + rendered text). */
async function editorOptions(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const eds = (window as unknown as { __dsEditors?: Ed[] }).__dsEditors ?? []
    const ed = eds[eds.length - 1]
    if (!ed) return null
    const el = document.querySelector('.monaco-editor .view-lines') as HTMLElement | null
    return {
      tabSize: ed.getModel()?.getOptions().tabSize ?? 0,
      fontSize: el ? Math.round(parseFloat(getComputedStyle(el).fontSize)) : 0,
    }
  })
}

async function openSqlTab(page: import('@playwright/test').Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(700)
}

test('Settings → Editor reaches the editor, live', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openSqlTab(page)

  const before = await editorOptions(page)
  expect(before, 'editor test seam missing').not.toBeNull()
  expect(before!.tabSize).toBe(2)
  expect(before!.fontSize).toBe(13) // design-token default

  await page.keyboard.press('Control+,') // Settings
  await page.waitForTimeout(400)

  // Appearance → Editor font size
  await page.getByText('Editor font size').locator('input').fill('18')
  await page.getByText('Editor font size').locator('input').dispatchEvent('change')
  await page.waitForTimeout(200)

  // Editor → Tab size + Word wrap
  await page.getByRole('button', { name: 'Editor', exact: true }).first().click()
  await page.waitForTimeout(200)
  const tabSize = page.getByText('Tab size').locator('input')
  await tabSize.fill('4')
  await tabSize.dispatchEvent('change')
  await page.getByText('Word wrap').locator('input').check()
  await page.waitForTimeout(400)

  await page.getByRole('dialog').getByRole('button', { name: '×' }).first().click() // close Settings
  await page.waitForTimeout(500)

  const after = await editorOptions(page)
  expect(after!.tabSize, 'tab size did not reach the model').toBe(4)
  expect(after!.fontSize, 'font size did not reach the editor').toBe(18)

  // the editor still works after the options changed
  await page.locator('.view-lines').first().click()
  await page.keyboard.type('SELECT 1')
  await expect(page.locator('.view-lines').first()).toContainText('SELECT 1')
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
