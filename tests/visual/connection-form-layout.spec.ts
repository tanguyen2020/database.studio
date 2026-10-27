import { expect, test, type Locator, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// New/Edit Connection layout: "Connection name" shares a row with
// "Environment", and Database · User · Password share one row (per engine,
// only the fields that engine shows).

async function openForm(page: Page, system: string) {
  await page.getByTitle('New connection').first().click()
  await page.locator(`.picker-card[title="${system}"]`).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('New connection', { exact: true })).toBeVisible()
  return dialog
}

/** Top edge of the input under a label (the field's row position). */
async function fieldBox(dialog: Locator, label: string | RegExp) {
  const field = dialog.locator('.cm-label', { hasText: label }).first().locator('xpath=..')
  const box = await field.locator('.cm-input').first().boundingBox()
  expect(box, `field ${label} is rendered`).not.toBeNull()
  return box!
}

async function sameRow(dialog: Locator, labels: (string | RegExp)[]) {
  const boxes = await Promise.all(labels.map((l) => fieldBox(dialog, l)))
  // bottoms line up (the row aligns inputs on their bottom edge; a <select> is 2px taller)
  const bottom = (b: { y: number; height: number }) => b.y + b.height
  for (const b of boxes.slice(1)) expect(Math.abs(bottom(b) - bottom(boxes[0])), `${labels.join(' · ')} on one row`).toBeLessThan(1.5)
  // left → right, without overlapping
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].x).toBeGreaterThanOrEqual(boxes[i - 1].x + boxes[i - 1].width)
  return boxes
}

test.beforeEach(async ({ page }) => {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
})

test('PostgreSQL: name | environment, then database · user · password on one row', async ({ page }) => {
  const dialog = await openForm(page, 'PostgreSQL')
  const [name, env] = await sameRow(dialog, ['Connection name', 'Environment'])
  const [host] = await sameRow(dialog, ['Host', 'Port'])
  const [db] = await sameRow(dialog, [/^Database$/, /^User$/, /^Password/])
  expect(name.y).toBeLessThan(host.y)
  expect(host.y).toBeLessThan(db.y)
  expect(env.width).toBeGreaterThan(100)
  if (process.env.SHOT_DIR) await dialog.screenshot({ path: `${process.env.SHOT_DIR}/form-postgres.png` })
})

test('per-engine credential rows keep only the fields that engine shows', async ({ page }) => {
  // Oracle: Connect by · Service name · User · Password
  let dialog = await openForm(page, 'Oracle')
  await sameRow(dialog, ['Connect by', 'Service name', /^User$/, /^Password/])
  if (process.env.SHOT_DIR) await dialog.screenshot({ path: `${process.env.SHOT_DIR}/form-oracle.png` })
  await dialog.getByText('Close', { exact: true }).click()

  // Redis: DB Index · Password (no user)
  dialog = await openForm(page, 'Redis')
  await sameRow(dialog, ['DB Index', /^Password/])
  await expect(dialog.locator('.cm-label', { hasText: /^User$/ })).toHaveCount(0)
  await dialog.getByText('Close', { exact: true }).click()

  // MSSQL: the auth picker leads the credentials row; Windows auth hides user/password
  dialog = await openForm(page, 'SQL Server')
  await sameRow(dialog, ['Authentication', /^Database$/, /^User$/, /^Password/])
  if (process.env.SHOT_DIR) await dialog.screenshot({ path: `${process.env.SHOT_DIR}/form-mssql.png` })
  await dialog.locator('.cm-label', { hasText: 'Authentication' }).locator('xpath=..').locator('select').selectOption('windows')
  await expect(dialog.locator('.cm-label', { hasText: /^User$/ })).toHaveCount(0)
  await expect(dialog.locator('.cm-label', { hasText: /^Password/ })).toHaveCount(0)
  await sameRow(dialog, ['Authentication', /^Database$/])
  await expect(dialog.getByText(/Integrated Security/)).toBeVisible()
  await dialog.getByText('Close', { exact: true }).click()

  // Kafka: no database field; SASL · User · Password on one row
  dialog = await openForm(page, 'Kafka')
  await expect(dialog.locator('.cm-label', { hasText: /^Database$/ })).toHaveCount(0)
  await sameRow(dialog, ['Authentication (SASL)', /^User$/, /^Password/])
  await dialog.getByText('Close', { exact: true }).click()

  // Elasticsearch: Authentication · User · Password
  dialog = await openForm(page, 'Elasticsearch')
  await sameRow(dialog, ['Authentication', /^User$/, /^Password/])
})

test('the form is wide enough that no field is squeezed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openForm(page, 'SQL Server')
  expect((await dialog.boundingBox())!.width).toBeGreaterThanOrEqual(1000)
  // four credential fields: each still gets a comfortable width
  for (const b of await sameRow(dialog, ['Authentication', /^Database$/, /^User$/, /^Password/])) expect(b.width).toBeGreaterThan(200)
  // on a narrow window the form still fits inside it
  await page.setViewportSize({ width: 900, height: 800 })
  const narrow = (await dialog.boundingBox())!
  expect(narrow.x).toBeGreaterThanOrEqual(0)
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(900)
})

test('typed values still bind after the move', async ({ page }) => {
  const dialog = await openForm(page, 'PostgreSQL')
  const input = (label: string | RegExp) =>
    dialog.locator('.cm-label', { hasText: label }).first().locator('xpath=..').locator('.cm-input').first()
  await input('Connection name').fill('layout-check')
  await input(/^Database$/).fill('app_db')
  await input(/^User$/).fill('app_user')
  await input(/^Password/).fill('secret')
  await expect(input('Connection name')).toHaveValue('layout-check')
  await expect(input(/^Database$/)).toHaveValue('app_db')
  await expect(input(/^User$/)).toHaveValue('app_user')
  await expect(input(/^Password/)).toHaveValue('secret')
})

test('the popup sizes itself to the visible controls', async ({ page }) => {
  const dialog = await openForm(page, 'PostgreSQL')
  const panel = page.locator('[role="dialog"][aria-label="New connection"]')
  const body = panel.locator(':scope > div > div').nth(1) // header · body · footer
  const height = async () => (await panel.boundingBox())!.height

  // few controls → compact: the body is exactly as tall as what it holds (no empty
  // band under the last control) and has no scrollbar
  const compact = await height()
  const slack = await body.evaluate((el) => {
    const last = el.lastElementChild!.getBoundingClientRect().bottom
    const inner = el.getBoundingClientRect().bottom - parseFloat(getComputedStyle(el).paddingBottom)
    return inner - last
  })
  expect(Math.abs(slack), 'no empty band under the last control').toBeLessThanOrEqual(2)
  expect(compact).toBeLessThan(page.viewportSize()!.height * 0.9)
  expect(await body.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)
  if (process.env.SHOT_DIR) await panel.screenshot({ path: `${process.env.SHOT_DIR}/form-compact.png` })

  // SSH tunnel adds fields → the popup grows to fit them instead of scrolling
  await dialog.getByText('SSH Tunnel').first().click()
  await expect.poll(height).toBeGreaterThan(compact + 80)
  const vh = page.viewportSize()!.height
  if ((await height()) < vh * 0.9 - 2) expect(await body.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)
  if (process.env.SHOT_DIR) await panel.screenshot({ path: `${process.env.SHOT_DIR}/form-ssh.png` })

  // turning it off shrinks it back
  await dialog.getByText('SSH Tunnel').first().click()
  await expect.poll(height).toBeLessThan(compact + 2)

  // short window: capped at 90vh, only the body scrolls, footer stays reachable
  await page.setViewportSize({ width: 1440, height: 520 })
  await dialog.getByText('SSH Tunnel').first().click()
  await expect.poll(height).toBeLessThanOrEqual(520 * 0.9 + 1)
  expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  await expect(dialog.getByText('Connect', { exact: true })).toBeInViewport()
  await expect(dialog.getByText('New connection', { exact: true })).toBeInViewport()
})

test('the form opens with the caret in Connection name, and the Connect label is centred', async ({ page }) => {
  const dialog = await openForm(page, 'PostgreSQL')
  await expect(dialog.getByRole('textbox', { name: 'Connection name' })).toBeFocused()
  // typing goes straight into the name
  await page.keyboard.type('Billing DB')
  await expect(dialog.getByRole('textbox', { name: 'Connection name' })).toHaveValue('Billing DB')

  // every footer button has its label in the middle (the primary one is wider)
  for (const name of ['Test connection', 'Close', 'Connect']) {
    const btn = dialog.getByText(name, { exact: true })
    const off = await btn.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(el)
      const t = range.getBoundingClientRect()
      return Math.abs(t.left + t.width / 2 - (r.left + r.width / 2))
    })
    expect(off, `${name}: label is off-centre by ${off}px`).toBeLessThan(2)
  }
})

// SSH authentication: the two methods are cards with their own colour + icon, so
// the chosen one is obvious (the old segmented pill was white-on-grey).
test('SSH: Username / Password vs Private Key are distinct, coloured choices', async ({ page }) => {
  const dialog = await openForm(page, 'PostgreSQL')
  await dialog.getByRole('switch', { name: 'SSH Tunnel' }).click()
  const group = dialog.getByRole('radiogroup', { name: 'Authentication' })
  const pw = group.getByRole('radio', { name: /Username \/ Password/ })
  const key = group.getByRole('radio', { name: /Private Key/ })
  await expect(pw).toHaveAttribute('aria-checked', 'true')
  await expect(key).toHaveAttribute('aria-checked', 'false')
  await expect(dialog.locator('.cm-label', { hasText: 'SSH Password' })).toBeVisible()

  const border = (l: Locator) => l.evaluate((el) => getComputedStyle(el).borderTopColor)
  const pwOn = await border(pw)
  const keyOff = await border(key)
  // the chosen card stands out from the other one
  expect(pwOn).not.toBe(keyOff)

  await key.click()
  await expect(key).toHaveAttribute('aria-checked', 'true')
  await expect(pw).toHaveAttribute('aria-checked', 'false')
  await expect(dialog.locator('.cm-label', { hasText: 'Private Key File' })).toBeVisible()
  await expect(dialog.locator('.cm-label', { hasText: 'SSH Password' })).toHaveCount(0)
  const keyOn = await border(key)
  // each method has its own colour — the two chosen states differ
  expect(keyOn).not.toBe(pwOn)
  expect(keyOn).not.toBe(keyOff)

  // keyboard: arrows switch between the two, like any radio group
  await key.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(pw).toHaveAttribute('aria-checked', 'true')
  await expect(pw).toBeFocused()
  if (process.env.SHOT_DIR) await dialog.locator('.cm-subpanel').first().screenshot({ path: `${process.env.SHOT_DIR}/form-ssh-auth.png` })
})
