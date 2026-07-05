import type { Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const PROTO_URL = 'http://localhost:4174/Database%20Studio.dc.html'
export const APP_URL = 'http://localhost:5173/'

/**
 * Chặn mọi request font bên ngoài (fonts.googleapis.com / fonts.gstatic.com).
 * Prototype link Google Fonts nhưng app Tauri (CSP strict) không được phép —
 * chặn ở CẢ HAI phía để cùng fallback về font hệ thống → render đồng nhất,
 * pixel diff không phụ thuộc mạng.
 */
export async function blockRemoteFonts(page: Page): Promise<void> {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort())
}

/**
 * The prototype's CSS declares `--font-mono: 'JetBrains Mono'`, and the app now
 * bundles that font (self-hosted via @fontsource). The static prototype page has
 * no way to load it, so inject the same bundled JetBrains Mono into BOTH pages so
 * pixel diffs compare JetBrains-Mono-vs-JetBrains-Mono (the prototype's declared
 * intent). Weights 400/600 match `.mono` usage. Base64 data URIs → no network, no
 * CORS, unaffected by blockRemoteFonts.
 */
let cachedFontFace: string | null = null
function monoFontFace(): string {
  if (cachedFontFace) return cachedFontFace
  const dir = fileURLToPath(new URL('../../node_modules/@fontsource/jetbrains-mono/files/', import.meta.url))
  const b64 = (w: number) => readFileSync(`${dir}jetbrains-mono-latin-${w}-normal.woff2`).toString('base64')
  const face = (w: number) =>
    `@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:${w};font-display:block;` +
    `src:url(data:font/woff2;base64,${b64(w)}) format('woff2');}`
  cachedFontFace = face(400) + face(600)
  return cachedFontFace
}
async function injectMonoFont(page: Page): Promise<void> {
  await page.addStyleTag({ content: monoFontFace() })
  await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready)
}

/** Mở prototype gốc, chờ DC runtime mount xong UI. */
export async function openPrototype(page: Page): Promise<void> {
  await blockRemoteFonts(page)
  await page.goto(PROTO_URL)
  // support.js parse template rồi mount — chờ workspace chính xuất hiện
  await page.waitForSelector('.ds', { timeout: 15_000 })
  await injectMonoFont(page)
  await page.waitForTimeout(300) // ổn định layout sau mount
}

/** Mở bản Svelte đang chạy trên vite dev. */
export async function openApp(page: Page): Promise<void> {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await injectMonoFont(page)
  await page.waitForTimeout(300)
}

/**
 * Đo computed style của 1 element — dùng cho bảng đối chiếu số đo
 * HTML-gốc vs Svelte (đối chiếu bằng số, không bằng mắt).
 */
export async function measure(
  page: Page,
  selector: string,
  props: string[],
): Promise<Record<string, string>> {
  return page.$eval(
    selector,
    (el, propList) => {
      const cs = getComputedStyle(el as Element)
      const out: Record<string, string> = {}
      for (const p of propList as string[]) out[p] = cs.getPropertyValue(p)
      const r = (el as Element).getBoundingClientRect()
      out['rect'] = `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}×${Math.round(r.height)}`
      return out
    },
    props,
  )
}
