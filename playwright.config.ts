import { defineConfig } from '@playwright/test'

// Visual regression: so pixel bản Svelte (5173) với prototype gốc
// "Database Studio.dc.html" (4174) ở CÙNG viewport 1440×900.
// Ngưỡng: chỉ dung sai anti-aliasing font (threshold 0.1), mọi lệch
// layout/màu/spacing/icon/text là BUG — không nới ngưỡng.
export default defineConfig({
  testDir: './tests/visual',
  fullyParallel: false,
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
