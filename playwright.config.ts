import { defineConfig } from '@playwright/test'
import os from 'node:os'
import { pickWorkers } from './src/lib/testing/pw-workers'

// Số worker theo cấu hình máy (CPU + RAM tổng + RAM còn trống) để chạy e2e không
// làm đơ máy; override bằng PW_WORKERS=<n>. Xem src/lib/testing/pw-workers.ts.
// Config được nạp lại trong từng worker: chốt kế hoạch MỘT lần ở process chính rồi
// truyền qua env, để mọi worker dùng cùng timeout (RAM trống đổi liên tục).
const GB = 1024 ** 3
const plan: { workers: number; timeout: number; reason: string } = process.env.DS_PW_PLAN
  ? JSON.parse(process.env.DS_PW_PLAN)
  : pickWorkers({
      cpus: os.cpus().length,
      totalGB: os.totalmem() / GB,
      freeGB: os.freemem() / GB,
      override: process.env.PW_WORKERS,
    })
if (!process.env.DS_PW_PLAN) {
  process.env.DS_PW_PLAN = JSON.stringify(plan)
  console.log(`[e2e] ${plan.reason}; timeout ${plan.timeout / 1000}s`)
}

// Visual regression: so pixel bản Svelte (5173) với prototype gốc
// "Database Studio.dc.html" (4174) ở CÙNG viewport 1440×900.
// Ngưỡng: chỉ dung sai anti-aliasing font (threshold 0.1), mọi lệch
// layout/màu/spacing/icon/text là BUG — không nới ngưỡng.
export default defineConfig({
  testDir: './tests/visual',
  fullyParallel: false,
  workers: plan.workers,
  timeout: plan.timeout,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  snapshotPathTemplate:
    '{testDir}/__screenshots__/{testFileName}/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      threshold: 0.1,
      maxDiffPixelRatio: 0.001,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  use: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  },
  webServer: [
    {
      // serve thư mục design để prototype load được support.js/selftest.js/assets
      command:
        'npx http-server "spec/Database Studio design/design_handoff_database_studio" -p 4174 -c-1 --silent',
      port: 4174,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'npm run dev',
      port: 5173,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
})
