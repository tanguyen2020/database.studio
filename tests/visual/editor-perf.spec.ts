import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Typing in the Query Editor must stay responsive on a BIG script and a BIG
// database. This is a real gate, not a smoke test: it types into the actual
// CodeMirror instance (completion sources + lint + persistence all live) and
// measures the main thread from inside the page.
//
// Regression it locks down: `splitStatements` used to convert every statement's
// start offset by rescanning the document from position 0 (O(n²)). The completion
// source runs it on every keystroke, so a 10k-line script froze the UI for ~190ms
// PER KEYSTROKE. Measured here before the fix: block=189ms; after: 0ms.
// (The algorithmic property is also pinned, machine-independently, by
// src/lib/sql/statements.perf.test.ts.)
//
// Measured per scenario:
//   • input processing time (Event Timing) — the latency of one keystroke;
//   • long tasks (>50ms) — the freezes the user actually feels;
//   • a CPU profile of the burst, printed so a future regression names its culprit.
//
// `?bigSchema=<tables>&bigFns=<count>` makes the demo backend answer introspection
// with a production-sized catalog (demo/browser only — see demo.ts).

const BIG = 'bigSchema=2000&bigFns=2000'
/** Total main-thread block allowed during one typing burst (5 completions).
 *  Measured pre-fix on this machine: 321ms / 108ms on the big-document scenarios,
 *  spread over several ~56ms tasks — which is why the budget is on the SUM, not on
 *  the longest single task. Post-fix: 0ms in every scenario. */
const BLOCK_BUDGET_MS = 100
/** Average per-keystroke handling time. Pre-fix on a big script: ~18ms. */
const INPUT_BUDGET_MS = 40

// Timing measurements are sensitive to CPU contention: with several Playwright
// workers on the same machine, an unrelated worker's burst can push this one's
// numbers over budget (and this spec's own load can do the same to others). Run
// perf specs with `--workers=1` for stable numbers; the retries below keep a
// contended run from reporting a regression that isn't there. A REAL regression
// is reproducible and fails all attempts — and is caught deterministically,
// machine-independently, by src/lib/sql/statements.perf.test.ts.
test.describe.configure({ retries: 2 })

type Ev = { name: string; proc: number }
type W = typeof window & { __perf?: { tasks: number[]; events: Ev[] } }

let initInstalled = false

async function boot(page: Page, query: string) {
  // addInitScript accumulates and re-runs ALL registered scripts on every
  // navigation — installing it per scenario would register N observers and count
  // each long task N times. Install exactly once.
  if (!initInstalled) {
    initInstalled = true
    await page.addInitScript(() => {
      const w = window as W
      w.__perf = { tasks: [], events: [] }
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) w.__perf!.tasks.push(e.duration)
        }).observe({ entryTypes: ['longtask'] })
      } catch {
        /* longtask unsupported → tasks stay empty, Event Timing still asserted */
      }
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries() as PerformanceEventTiming[]) {
            if (e.name === 'input' || e.name === 'keydown')
              w.__perf!.events.push({ name: e.name, proc: e.processingEnd - e.processingStart })
          }
        }).observe({ type: 'event', buffered: true, durationThreshold: 0 } as PerformanceObserverInit)
      } catch {
        /* ignore */
      }
    })
  }
  await blockRemoteFonts(page)
  await page.goto(query ? `${APP_URL}?${query}` : APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(800)
}

const STMT = `SELECT u.id, u.first_name, o.total
FROM public.tbl_5 u
JOIN public.tbl_6 o ON o.user_id = u.id
WHERE u.created_at > now() AND o.total > 100
ORDER BY o.total DESC LIMIT 50;

`

async function reset(page: Page) {
  await page.evaluate(() => {
    const w = window as W
    w.__perf!.tasks = []
    w.__perf!.events = []
  })
}

async function collect(page: Page) {
  await page.waitForTimeout(600) // let both observers flush
  return page.evaluate(() => {
    const w = window as W
    const t = w.__perf!.tasks
    const inputs = w.__perf!.events.filter((e) => e.name === 'input').map((e) => e.proc)
    return {
      inputAvg: inputs.length ? +(inputs.reduce((a, b) => a + b, 0) / inputs.length).toFixed(1) : 0,
      inputMax: inputs.length ? +Math.max(...inputs).toFixed(1) : 0,
      maxTask: t.length ? +Math.max(...t).toFixed(0) : 0,
      blockMs: +t.reduce((a, b) => a + b, 0).toFixed(0),
      longTasks: t.length,
    }
  })
}

/** CPU profile of the burst → top self-time functions, so a failure says WHICH
 *  function got slow instead of just "it got slow". */
async function profileTop(page: Page, burst: () => Promise<void>) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Profiler.start')
  await burst()
  await page.waitForTimeout(300)
  const { profile } = (await cdp.send('Profiler.stop')) as {
    profile: {
      nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]
      samples: number[]
      timeDeltas: number[]
    }
  }
  await cdp.detach()
  const self = new Map<number, number>()
  profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000))
  const byFn = new Map<string, number>()
  for (const n of profile.nodes) {
    const ms = self.get(n.id) ?? 0
    if (ms <= 0) continue
    const fn = n.callFrame.functionName || '(anonymous)'
    if (fn === '(idle)' || fn === '(program)' || fn === '(garbage collector)') continue
    const file = n.callFrame.url.split('/').slice(-1)[0].split('?')[0] || '(native)'
    byFn.set(`${fn} @ ${file}:${n.callFrame.lineNumber + 1}`, (byFn.get(`${fn} @ ${file}:${n.callFrame.lineNumber + 1}`) ?? 0) + ms)
  }
  return [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
}

async function scenario(page: Page, params: string, repeats: number) {
  await boot(page, params)
  await page.locator('.cm-content').first().click()
  if (repeats > 0) {
    await page.keyboard.insertText(STMT.repeat(repeats))
    await page.waitForTimeout(2500)
  }
  // real document size (CodeMirror virtualises the DOM, so textContent is only
  // the viewport) — the last line number in the gutter after jumping to the end
  await page.keyboard.press('Control+End')
  await page.waitForTimeout(300)
  const lines = await page.evaluate(() => {
    const nums = [...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
      .map((e) => Number(e.textContent))
      .filter((n) => Number.isFinite(n) && n > 0)
    return nums.length ? Math.max(...nums) : 0
  })

  // Land in a real completion context at the END of the document (the worst case:
  // everything before the caret must be understood to know which statement it is).
  await page.keyboard.insertText('\n\nSELECT * FROM public.tbl_5 u JOIN public.tbl_6 o ON o.id = u.id;\n')
  await page.waitForTimeout(1200)
  await page.keyboard.insertText('SELECT ')
  await page.waitForTimeout(600)
  await page.keyboard.press('u') // warm-up: triggers the lazy column load
  await page.waitForTimeout(1200)

  await reset(page)
  // Burst: type after `alias.` and ask for completion EXPLICITLY (Ctrl+Space) each
  // time. Explicit activation always runs the completion sources, so the column
  // source must resolve which statement the caret sits in — the work that used to
  // rescan the whole document. Relying on the popup opening by itself made the
  // measurement non-deterministic (a regression could slip through unmeasured).
  await page.keyboard.type(' u.')
  await page.waitForTimeout(300)
  const top = await profileTop(page, async () => {
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('f')
      await page.keyboard.press('Control+Space')
      await page.waitForTimeout(120)
      await page.keyboard.press('Backspace')
    }
  })
  return { lines, top, ...(await collect(page)) }
}

test('typing stays responsive on a big script and a big database', async ({ page }) => {
  test.setTimeout(420_000)
  const out: Record<string, Awaited<ReturnType<typeof scenario>>> = {}

  out['small schema / small doc'] = await scenario(page, '', 0)
  out['BIG schema   / small doc'] = await scenario(page, BIG, 0)
  out['small schema / BIG doc'] = await scenario(page, '', 400)
  out['BIG schema   / BIG doc'] = await scenario(page, BIG, 400)

  const report = Object.entries(out)
    .map(([k, v]) => {
      const head = `  ${k.padEnd(26)} lines=${String(v.lines).padStart(5)}  input avg=${String(v.inputAvg).padStart(5)}ms max=${String(v.inputMax).padStart(5)}ms  longTasks=${v.longTasks} maxTask=${v.maxTask}ms block=${v.blockMs}ms`
      return `${head}\n${v.top.map(([n, ms]) => `        ${String(Math.round(ms)).padStart(4)}ms  ${n}`).join('\n')}`
    })
    .join('\n')
  console.log(`\n[editor typing perf — burst of 10 keystrokes]\n${report}\n`)

  for (const [name, v] of Object.entries(out)) {
    expect(v.blockMs, `${name}: main-thread blocked during typing (long tasks: ${v.longTasks})`).toBeLessThan(
      BLOCK_BUDGET_MS,
    )
    expect(v.inputAvg, `${name}: average keystroke handling time`).toBeLessThan(INPUT_BUDGET_MS)
  }
  // the big-document scenarios must really have loaded a big document
  expect(out['small schema / BIG doc'].lines).toBeGreaterThan(2000)
  expect(out['BIG schema   / BIG doc'].lines).toBeGreaterThan(2000)
})
