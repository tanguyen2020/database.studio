// Phase 1 — đối chiếu BẰNG SỐ ĐO khung UI (chrome) giữa prototype gốc và bản
// Svelte: title bar / tab bar / status bar / sidebar / toolbar. Mỗi dòng đo
// computed style ở CẢ HAI trang và phải KHỚP — còn dòng lệch = fail.
// Screenshot cả 2 trang được đính vào report (test-results/).
//
// Pixel-diff toàn màn phụ thuộc DATA (prototype chạy mock CONNS/tabs, app chạy
// dữ liệu thật) — sẽ so từng màn sau khi seed demo data; khung chrome so ở đây.

import { expect, test } from '@playwright/test'
import { APP_URL, PROTO_URL, blockRemoteFonts, measure, openApp, openPrototype } from './helpers'

// [tên phép đo, selector prototype, selector app, các property phải khớp]
const CHECKS: Array<[string, string, string, string[]]> = [
  [
    'title bar',
    '.ds > div:nth-child(1)',
    '#app > div > div:nth-child(1)',
    ['height', 'background-color', 'border-bottom-color', 'border-bottom-width'],
  ],
  [
    'status bar',
    // proto: body(2) > main(3) > statusbar(last) — app phản chiếu cùng cấu trúc,
    // StatusBar nằm trong <main> (App.svelte dòng 166), không phải last-child của root.
    '.ds > div:nth-child(2) > div:nth-child(3) > div:last-child',
    '#app > div > div:nth-child(2) > main > div:last-child',
    ['height', 'background-color', 'border-top-width', 'font-size', 'color'],
  ],
]

test('chụp prototype + app để đính báo cáo', async ({ page }) => {
  await openPrototype(page)
  await page.screenshot({ path: 'test-results/proto-workspace-dark.png', fullPage: false })
  await openApp(page)
  await page.screenshot({ path: 'test-results/app-workspace-dark.png', fullPage: false })
})

test('bảng đối chiếu số đo khung chrome', async ({ page, browser }) => {
  // đo prototype
  await openPrototype(page)
  const protoVals: Record<string, Record<string, string>> = {}
  for (const [name, protoSel, , props] of CHECKS) {
    protoVals[name] = await measure(page, protoSel, props)
  }

  // đo app (context riêng để sạch state)
  const appPage = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await blockRemoteFonts(appPage)
  await appPage.goto(APP_URL)
  await appPage.waitForSelector('#app > *', { timeout: 15_000 })
  await appPage.waitForTimeout(400)

  const rows: string[] = []
  let mismatches = 0
  for (const [name, , appSel, props] of CHECKS) {
    const appVals = await measure(appPage, appSel, props)
    for (const p of props) {
      const a = protoVals[name][p]
      const b = appVals[p]
      const ok = a === b
      if (!ok) mismatches++
      rows.push(`${ok ? 'KHỚP ' : 'LỆCH '} | ${name} | ${p} | proto=${a} | app=${b}`)
    }
  }
  console.log('\n=== BẢNG ĐỐI CHIẾU SỐ ĐO ===\n' + rows.join('\n'))
  expect(mismatches, 'còn dòng LỆCH trong bảng đối chiếu:\n' + rows.join('\n')).toBe(0)
  await appPage.close()
})

test('theme vars: 13 biến .ds khớp tokens.css sinh tự động', async ({ page }) => {
  await blockRemoteFonts(page)
  await page.goto(PROTO_URL)
  await page.waitForSelector('.ds')
  const protoVars = await page.$eval('.ds', (el) => {
    const cs = getComputedStyle(el)
    const names = ['--bg', '--surface', '--panel', '--raised', '--border', '--border2', '--text', '--text2', '--muted', '--header', '--hover', '--primary', '--grid-zebra']
    return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]))
  })

  await page.goto(APP_URL)
  await page.waitForSelector('#app > *')
  const appVars = await page.$eval('html', (el) => {
    const cs = getComputedStyle(el)
    const names = ['--bg', '--surface', '--panel', '--raised', '--border', '--border2', '--text', '--text2', '--muted', '--header', '--hover', '--primary', '--grid-zebra']
    return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]))
  })

  expect(appVars).toEqual(protoVars)
})
