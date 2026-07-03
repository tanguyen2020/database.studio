import type { Page } from '@playwright/test'

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

/** Mở prototype gốc, chờ DC runtime mount xong UI. */
export async function openPrototype(page: Page): Promise<void> {
  await blockRemoteFonts(page)
  await page.goto(PROTO_URL)
  // support.js parse template rồi mount — chờ workspace chính xuất hiện
  await page.waitForSelector('.ds', { timeout: 15_000 })
  await page.waitForTimeout(300) // ổn định layout sau mount
}

/** Mở bản Svelte đang chạy trên vite dev. */
export async function openApp(page: Page): Promise<void> {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
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
