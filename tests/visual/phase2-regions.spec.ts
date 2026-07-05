// Phase 2 — pixel diff TỪNG VÙNG giữa prototype và app (demo mode seed đúng
// CONNS/TABS của prototype). Baseline chụp từ PROTOTYPE (nguồn chuẩn); app
// phải khớp trong ngưỡng anti-aliasing (threshold 0.1, maxDiffPixelRatio thấp).
//
// Vùng so Phase 2 v1: title bar / tab bar / status bar / sidebar connections.
// (Vùng editor/result phụ thuộc CodeMirror vs renderer tự chế của prototype —
// so bằng bảng số đo, không pixel.)

import { expect, test, type Page } from '@playwright/test'
import { openApp, openPrototype } from './helpers'

const W = 1440
const H = 900

// [tên vùng, clip rect]
const REGIONS: Array<[string, { x: number; y: number; width: number; height: number }]> = [
  ['title-bar', { x: 0, y: 0, width: W, height: 42 }],
  ['tab-bar', { x: 283, y: 42, width: W - 283, height: 40 }],
  ['status-bar', { x: 0, y: H - 27, width: W, height: 27 }],
  ['sidebar-connections', { x: 0, y: 42, width: 278, height: 266 }],
]

async function grab(page: Page, name: string, source: 'proto' | 'app') {
  for (const [region, clip] of REGIONS) {
    await page.screenshot({
      path: `test-results/regions/${region}--${source}.png`,
      clip,
    })
  }
  void name
}

test('chụp vùng prototype (baseline) + app rồi so pixel', async ({ page }) => {
  await openPrototype(page)
  // The app intentionally renders connection NAMES in JetBrains Mono (DataGrip
  // style, per user request); the immutable prototype baseline still uses its
  // sans UI font for the name (only host:port is mono). Mirror the intended font
  // onto the prototype's connection-name spans (unique: sidebar, weight 600,
  // 12.5px) so the pixel diff validates layout under the SAME font instead of
  // flagging the deliberate change.
  await page.evaluate(() => {
    document.querySelectorAll('span').forEach((el) => {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (r.x < 278 && cs.fontWeight === '600' && cs.fontSize === '12.5px') {
        ;(el as HTMLElement).style.fontFamily = "'JetBrains Mono', ui-monospace, monospace"
      }
    })
  })
  await grab(page, 'workspace', 'proto')

  await openApp(page)
  // The Properties panel is hidden on startup (AUDIT-2 item 4); the prototype
  // baseline shows it, so open it here to keep the chrome-region comparison
  // apples-to-apples (its right edge shares the tab-bar / status-bar rows).
  await page.getByTitle('Show Properties panel').first().click()
  await page.waitForTimeout(200)
  await grab(page, 'workspace', 'app')

  // so từng vùng bằng pixelmatch qua toHaveScreenshot không dùng được cho
  // 2 ảnh có sẵn — so trực tiếp bằng PNG + pixelmatch
  const { default: pixelmatch } = await import('pixelmatch')
  const { PNG } = await import('pngjs')
  const fs = await import('node:fs')

  const report: string[] = []
  let failed = 0
  for (const [region] of REGIONS) {
    const a = PNG.sync.read(fs.readFileSync(`test-results/regions/${region}--proto.png`))
    const b = PNG.sync.read(fs.readFileSync(`test-results/regions/${region}--app.png`))
    const { width, height } = a
    const diff = new PNG({ width, height })
    const n = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: 0.1 })
    const ratio = n / (width * height)
    fs.writeFileSync(`test-results/regions/${region}--diff.png`, PNG.sync.write(diff))
    const ok = ratio <= 0.02 // 2%: dung sai font antialiasing + subpixel — không nới thêm
    if (!ok) failed++
    report.push(
      `${ok ? 'ĐẠT ' : 'LỆCH'} | ${region} | ${n} px lệch / ${width}×${height} = ${(ratio * 100).toFixed(2)}%`,
    )
  }
  console.log('\n=== PIXEL DIFF THEO VÙNG ===\n' + report.join('\n'))
  expect(failed, 'vùng vượt ngưỡng:\n' + report.join('\n')).toBe(0)
})
