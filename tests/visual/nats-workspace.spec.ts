import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, wsSection } from './helpers'

// The classic NATS tab (core subscribe / publish / request + object store) is now two
// sections of the NATS workspace: "Publish & subscribe" and "Object stores".

async function openNats(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Messaging NATS/ }).dblclick()
  const ws = page.locator('[data-stream-shell="nats"]')
  await expect(ws).toBeVisible()
  return { errors, ws }
}

test('nats: Publish & subscribe lives in the workspace — listen, publish, keep listening across sections, request', async ({ page }) => {
  const { errors, ws } = await openNats(page)
  // a section of the workspace (no separate tab any more)
  await ws.locator('nav[aria-label="Sections"] [data-section="messaging"]').click()
  await expect(ws.locator('nav[aria-label="Sections"] [data-section="messaging"]')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('tab', { name: /Messaging NATS$/ }), 'still the one workspace tab, no extra NATS tab').toHaveCount(1)
  const msg = ws.locator('[data-nats-messaging]')
  await expect(msg.getByText('Not listening', { exact: true })).toBeVisible()

  // an invalid subject is explained, and Listen waits for a valid one
  const listenOn = msg.getByRole('textbox', { name: 'Subject to listen on' })
  await listenOn.fill('orders.>.eu')
  await expect(msg.getByText('">" can only be the last part of a subject')).toBeVisible()
  await expect(msg.getByRole('button', { name: 'Listen' })).toBeDisabled()

  await listenOn.fill('orders.>')
  await msg.getByRole('button', { name: 'Listen' }).click()
  await expect(msg.locator('[data-state="listening"]')).toContainText('orders.>')

  // publishing on a matching subject shows up; a non-matching one does not
  const sendTo = msg.getByRole('textbox', { name: 'Subject to send to' })
  const payload = msg.getByRole('textbox', { name: 'Payload' })
  const received = msg.getByRole('table', { name: 'Received messages' }).locator('tbody tr')
  await sendTo.fill('orders.eu')
  await payload.fill('{"id": 42}')
  await msg.getByRole('button', { name: 'Publish', exact: true }).last().click()
  await expect(msg.getByText('Published to')).toBeVisible()
  await expect(received).toHaveCount(1)
  await expect(received.first()).toContainText('orders.eu')
  await sendTo.fill('payments.us')
  await msg.getByRole('button', { name: 'Publish', exact: true }).last().click()
  await page.waitForTimeout(300)
  await expect(received).toHaveCount(1)

  // a wildcard cannot be a destination
  await sendTo.fill('orders.*')
  await expect(msg.getByText(/wildcards \(\* and >\) are only for listening/)).toBeVisible()

  // listening goes on while another section is open
  await wsSection(page, 'streams')
  await wsSection(page, 'messaging')
  await sendTo.fill('orders.us')
  await msg.getByRole('button', { name: 'Publish', exact: true }).last().click()
  await expect(received).toHaveCount(2)
  await expect(received.first()).toContainText('orders.us')

  // pause holds new messages back; Stop ends listening
  await msg.getByRole('button', { name: 'Pause' }).click()
  await expect(msg.locator('[data-state="paused"]')).toBeVisible()
  await msg.getByRole('button', { name: 'Publish', exact: true }).last().click()
  await page.waitForTimeout(300)
  await expect(received).toHaveCount(2)
  await msg.getByRole('button', { name: 'Stop' }).click()
  await expect(msg.getByText('Not listening', { exact: true })).toBeVisible()

  // request / reply
  await msg.getByRole('button', { name: 'Request', exact: true }).click()
  await sendTo.fill('svc.echo')
  await msg.getByRole('button', { name: 'Send request' }).click()
  await expect(msg.getByRole('status', { name: 'Reply' })).toContainText('"demo":"reply"')
  expect(errors, errors.join('\n')).toEqual([])
})

test('nats: Object stores — create a bucket in the app, see its files, delete with a confirm', async ({ page }) => {
  const { errors, ws } = await openNats(page)
  await wsSection(page, 'objects')
  const obj = ws.locator('[data-nats-objects]')
  const buckets = obj.getByRole('complementary', { name: 'Object store buckets' })
  await expect(buckets.getByRole('button', { name: 'uploads' })).toBeVisible()

  // a new bucket is an in-app form (no browser prompt); a taken name is refused
  await obj.getByRole('button', { name: 'New bucket' }).click()
  const name = obj.getByRole('textbox', { name: 'New bucket name' })
  await name.fill('uploads')
  await expect(obj.getByText('A bucket with this name already exists')).toBeVisible()
  await expect(obj.getByRole('button', { name: 'Create bucket' })).toBeDisabled()
  await name.fill('reports')
  await obj.getByRole('button', { name: 'Create bucket' }).click()
  await expect(buckets.getByRole('button', { name: 'reports' })).toHaveAttribute('aria-current', 'true')

  // files of a bucket; deleting one asks first, naming the file and its size
  await buckets.getByRole('button', { name: 'uploads' }).click()
  const files = obj.getByRole('table', { name: 'Files in uploads' })
  await expect(files.getByText('avatar.png')).toBeVisible()
  await files.getByRole('button', { name: 'Delete avatar.png' }).click()
  const dlg = page.getByRole('alertdialog', { name: 'Delete file' })
  await expect(dlg).toContainText('avatar.png')
  await dlg.getByRole('button', { name: 'Cancel' }).click()
  await expect(files.getByText('avatar.png')).toBeVisible()
  await files.getByRole('button', { name: 'Delete avatar.png' }).click()
  await page.getByRole('alertdialog', { name: 'Delete file' }).getByRole('button', { name: 'Delete file' }).click()
  await expect(files.getByText('avatar.png')).toHaveCount(0)

  // deleting a bucket names how many files go with it
  await obj.getByRole('button', { name: 'Delete bucket…' }).click()
  const bdlg = page.getByRole('alertdialog', { name: 'Delete bucket' })
  await expect(bdlg.getByRole('button', { name: 'Delete bucket and 1 file' })).toBeVisible()
  await bdlg.getByRole('button', { name: 'Delete bucket and 1 file' }).click()
  await expect(buckets.getByRole('button', { name: 'uploads' })).toHaveCount(0)
  expect(errors, errors.join('\n')).toEqual([])
})
