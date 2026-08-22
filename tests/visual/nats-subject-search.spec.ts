import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Searching a subject means "find the subject I half-remember": matched against
// subject NAMES, as a PREFIX, ignoring case. NATS filters cannot do that (they are
// per whole token and case-sensitive), so the search reads the server's per-subject
// index — one API call, no walking of messages. One match browses straight away,
// several are listed to pick from, none says so instead of leaving the old list up.

async function openInbox(page: import('@playwright/test').Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  await page.waitForTimeout(400)
  await page.getByText('INBOX', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('_INBOX.>', { exact: true }).first().click()
  await page.waitForTimeout(600)
}

test('a partial token, lower-case, finds the subjects that start with it', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openInbox(page)

  const search = page.getByLabel('Search subject')
  const subjects = async () =>
    new Set(await page.locator('tbody tr td:nth-child(3)').allInnerTexts())

  // the browse view holds several subjects
  expect((await subjects()).size).toBeGreaterThan(0)

  // exactly the case the user hit: partial token, wrong case
  await search.fill('_inbox.opjxo')
  await search.press('Enter')
  await page.waitForTimeout(800)

  // two subjects start with it → they are listed, the message grid is NOT left up
  await expect(page.getByText(/2 subjects start with/)).toBeVisible()
  await expect(page.getByText('_INBOX.opJXokMoF2', { exact: true })).toBeVisible()
  await expect(page.getByText('_INBOX.opJXokMoF2.1', { exact: true })).toBeVisible()
  // unrelated subjects are gone (this was the bug: they stayed on screen)
  await expect(page.getByText('_INBOX.SIhRBL845v', { exact: true })).toHaveCount(0)
  await expect(page.getByText('_INBOX.4iJnssqTsA', { exact: true })).toHaveCount(0)

  // picking one browses its messages, filtered by the server
  await page.getByText('_INBOX.opJXokMoF2.1', { exact: true }).click()
  await page.waitForTimeout(800)
  await expect(page.getByText('filter _INBOX.opJXokMoF2.1')).toBeVisible()
  expect(await subjects()).toEqual(new Set(['_INBOX.opJXokMoF2.1']))
  // and the match count leads back to the list
  await page.getByRole('button', { name: /2 subjects match/ }).click()
  await page.waitForTimeout(400)
  await expect(page.getByText(/2 subjects start with/)).toBeVisible()

  expect(errors, 'page errors: ' + errors.join(String.fromCharCode(10))).toEqual([])
})

test('a single match browses it straight away; no match says so', async ({ page }) => {
  await openInbox(page)
  const search = page.getByLabel('Search subject')

  // unique prefix → straight to that subject's messages
  await search.fill('_inbox.sih')
  await search.press('Enter')
  await page.waitForTimeout(900)
  await expect(page.getByText('filter _INBOX.SIhRBL845v')).toBeVisible()
  expect(new Set(await page.locator('tbody tr td:nth-child(3)').allInnerTexts())).toEqual(
    new Set(['_INBOX.SIhRBL845v']),
  )

  // nothing matches → the old list must not stay up pretending the search worked
  await search.fill('_inbox.zzz')
  await search.press('Enter')
  await page.waitForTimeout(900)
  await expect(page.getByText(/No subject in this stream starts with/)).toBeVisible()
  await expect(page.locator('tbody tr')).toHaveCount(0)
  await expect(page.getByText(/subject.* checked/)).toBeVisible() // says how much it covered

  // clearing goes back to browsing the stream's own subject
  await page.getByTitle('Clear search').click()
  await page.waitForTimeout(700)
  expect(await page.locator('tbody tr').count()).toBeGreaterThan(0)
})

// Clearing a search has to hand back a working search box AND a working browse
// view: the state of the previous search must not survive it (this used to leave
// the last query "applied", so Enter did nothing and the old results stayed up).
test('clearing a search lets the next one run, including the same query again', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openInbox(page)

  const search = page.getByLabel('Search subject')
  const rows = () => page.locator('tbody tr')
  const clear = () => page.getByTitle('Clear search')

  // search → clear → browse view is back (not an empty grid)
  await search.fill('_inbox.opjxo')
  await search.press('Enter')
  await page.waitForTimeout(800)
  await expect(page.getByText(/2 subjects start with/)).toBeVisible()
  await clear().click()
  await page.waitForTimeout(800)
  expect(await rows().count()).toBeGreaterThan(0)
  await expect(page.getByText(/subjects start with/)).toHaveCount(0)

  // the SAME query again must run again
  await search.fill('_inbox.opjxo')
  await search.press('Enter')
  await page.waitForTimeout(800)
  await expect(page.getByText(/2 subjects start with/)).toBeVisible()

  // and once more, without clearing in between
  await search.press('Enter')
  await page.waitForTimeout(800)
  await expect(page.getByText(/2 subjects start with/)).toBeVisible()

  // pick one, clear, then browse again — no leftover filter
  await page.getByText('_INBOX.opJXokMoF2.1', { exact: true }).click()
  await page.waitForTimeout(800)
  await expect(page.getByText('filter _INBOX.opJXokMoF2.1')).toBeVisible()
  await clear().click()
  await page.waitForTimeout(800)
  await expect(page.getByText(/^filter /)).toHaveCount(0)
  expect(await rows().count()).toBeGreaterThan(0)

  // the path that actually broke: pick a subject → go back to the match list →
  // clear. There is no filter left to drop at that point and the message list was
  // emptied, so the grid stayed blank and the search looked stuck.
  await search.fill('_inbox.opjxo')
  await search.press('Enter')
  await page.waitForTimeout(800)
  await page.getByText('_INBOX.opJXokMoF2.1', { exact: true }).click()
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: /2 subjects match/ }).click()
  await page.waitForTimeout(400)
  await expect(page.getByText(/2 subjects start with/)).toBeVisible()
  const pagesBefore = await page.evaluate(
    () => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.nats_js_subject_page ?? 0,
  )
  await clear().click()
  await page.waitForTimeout(800)
  // clearing must RE-READ the tab's subject, not just hide the search: from the
  // match list there is no filter left to drop and the message list was emptied
  expect(
    await page.evaluate(
      () => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.nats_js_subject_page ?? 0,
    ),
    'clearing re-reads the tab subject',
  ).toBeGreaterThan(pagesBefore)
  expect(await rows().count(), 'browsing is back after clearing from the match list').toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: /subjects match/ })).toHaveCount(0)

  // a no-match search followed by a clear also recovers
  await search.fill('_inbox.zzz')
  await search.press('Enter')
  await page.waitForTimeout(800)
  await expect(page.getByText(/No subject in this stream starts with/)).toBeVisible()
  await clear().click()
  await page.waitForTimeout(800)
  expect(await rows().count()).toBeGreaterThan(0)

  expect(errors, 'page errors: ' + errors.join(String.fromCharCode(10))).toEqual([])
})
