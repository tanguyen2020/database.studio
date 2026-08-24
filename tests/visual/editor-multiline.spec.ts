import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Two regressions from the move to Monaco, both reported from the real app:
//
// 1. Suggestions stopped working on any line below a line break. Monaco keeps the
//    document's own line endings (CRLF here) while CodeMirror — which drives the
//    completion sources — normalises to LF, so an offset taken from one and used
//    in the other drifted by one character per line above the caret: the
//    completion range covered the wrong text and Monaco discarded every item
//    ("No suggestions.").
// 2. The FIRST editor of a session took its tab down with
//    "Cannot read properties of undefined (reading 'editor')" — setup did not wait
//    for the on-demand Monaco load, so it called the API before it arrived. Every
//    later editor worked, which is why it only showed on the tab opened right
//    after connecting.

type Ed = { getModel: () => { getValue: () => string; getEOL: () => string } | null }

async function docOf(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const eds = ((window as unknown as { __dsEditors?: Ed[] }).__dsEditors ?? []).filter((e) => e.getModel())
    const model = eds[eds.length - 1]?.getModel()
    return model ? { text: model.getValue(), eol: model.getEOL() } : null
  })
}

test('suggestions keep working on a later line (statement, blank lines, statement)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(700)

  const content = page.locator('.view-lines').first()
  await content.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')

  // exactly the reported document: a finished statement, blank lines, then a new one
  await page.keyboard.type('select * from academic_sessions;')
  await page.keyboard.press('Escape')
  for (let i = 0; i < 3; i++) await page.keyboard.press('Enter')
  await page.keyboard.type('select * from stu')
  await page.waitForTimeout(700)

  const tip = page.locator('.suggest-widget.visible')
  await expect(tip, 'no suggestions on line 4').toBeVisible({ timeout: 4000 })
  await expect(tip).toContainText('students')

  // and accepting inserts over the WORD only — the give-away of a shifted range
  // would be a replacement that eats part of "from"
  await page.keyboard.press('Tab')
  await page.waitForTimeout(250)
  const doc = await docOf(page)
  expect(doc?.text.split('\n').pop()).toBe('select * from students')
  // the model is normalised to LF, so its offsets match the completion sources'
  expect(doc?.eol).toBe('\n')
  expect(doc?.text).not.toContain('\r')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('the first editor of a session mounts without taking its tab down', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(1200) // the on-demand Monaco load lands in here

  // no tab may have fallen into the error boundary — including a hidden
  // keep-alive pane, which is where the first (racing) editor used to crash
  expect(await page.getByText('Tab error').count(), 'a tab crashed while Monaco was loading').toBe(0)

  // the seeded query tab really did get an editor
  await page.getByRole('tab', { name: /query|SELECT|SQL/ }).first().click()
  await page.waitForTimeout(600)
  expect(await page.getByText('Tab error').count()).toBe(0)
  await expect(page.locator('.view-lines').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
