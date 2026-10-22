import { defineConfig } from '@playwright/test'
import os from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { cpuBudget, e2eAffinityMask, pickWorkers } from './src/lib/testing/pw-workers'

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
  pinToHalfTheCores()
}

/**
 * Pin the whole e2e run to half of the CPU cores (PW_ALL_CPUS=1 opts out).
 * Limiting workers is not enough: a single Chromium plus the dev server spreads
 * over every core and the machine stalls. Set once, here in the main process,
 * BEFORE Playwright starts the web servers, workers and browsers — child
 * processes inherit the affinity (Windows and Linux).
 */
function pinToHalfTheCores() {
  if (process.env.PW_ALL_CPUS === '1') return
  const cpus = os.cpus().length
  const mask = e2eAffinityMask(cpus)
  if (mask === null) return
  const first = cpus - cpuBudget(cpus)
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${process.pid}).ProcessorAffinity = ${mask}`], { stdio: 'ignore' })
      // Chromium starts its GPU process in a way that does NOT inherit the
      // affinity (measured: browser, renderer and utility processes ran on the
      // pinned cores, the GPU process on all of them; headless it rasterises in
      // software, so it costs CPU, and `--in-process-gpu` is ignored by the
      // headless shell). A small watcher — itself on the pinned cores — re-pins
      // any descendant that escaped, every 2 s, and exits with the run.
      // exits with the run: the root process must still exist AND be the same
      // process (same start time — a PID can be reused)
      const watcher =
        `$root=${process.pid};$mask=[int64]${mask};$t0=(Get-Process -Id $root).StartTime;` +
        `while(($r=Get-Process -Id $root -EA SilentlyContinue) -and $r.StartTime -eq $t0){` +
        `$kids=@{};foreach($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId){$kids[[int]$p.ParentProcessId]+=@([int]$p.ProcessId)};` +
        `$seen=@{};$q=[System.Collections.Queue]::new();$q.Enqueue($root);` +
        `while($q.Count){$id=$q.Dequeue();foreach($c in $kids[$id]){if($seen[$c]){continue};$seen[$c]=1;$q.Enqueue($c);` +
        `$pr=Get-Process -Id $c -EA SilentlyContinue;if($pr -and [int64]$pr.ProcessorAffinity -ne $mask){try{$pr.ProcessorAffinity=$mask}catch{}}}};` +
        `Start-Sleep -Seconds 2}`
      // a plain child (a detached one was measured to do nothing), hidden, and
      // unref'd so it never keeps the run alive
      spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', watcher], { stdio: 'ignore', windowsHide: true }).unref()
    } else if (process.platform === 'linux') {
      execFileSync('taskset', ['-p', mask.toString(16), String(process.pid)], { stdio: 'ignore' })
    } else {
      console.log('[e2e] CPU pinning is not available on this OS — running on all cores')
      return
    }
    console.log(`[e2e] pinned to CPUs ${first}-${cpus - 1} (${cpuBudget(cpus)} of ${cpus}); PW_ALL_CPUS=1 to use all`)
  } catch (e) {
    console.log(`[e2e] could not pin CPUs (${(e as Error).message}) — running on all cores`)
  }
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
    // Specs written against the full-height Explorer panel (its header, Refresh
    // and footer) run in the two-panel layout, which keeps that Explorer exactly.
    // The one sidebar (the app's default) has its own specs that clear this:
    // `test.use({ storageState: ONE_SIDEBAR })` in tests/visual/helpers.ts.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: new URL(process.env.DS_APP_URL ?? 'http://localhost:5173/').origin,
          localStorage: [{ name: 'sidebar_layout', value: 'left' }],
        },
      ],
    },
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
