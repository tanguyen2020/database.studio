// How many Playwright workers this machine can run without freezing it.
//
// Every worker is a full Chromium page running the app (Monaco, the grid, the demo
// backend) against ONE shared Vite dev server — so the limit is not "half the
// cores" (Playwright's default) but whichever runs out first: CPU (the dev server
// and the OS need cores too) or memory (each page costs ~1.2 GB; when RAM is short
// Windows starts paging and the whole machine stalls, tests time out at random).
//
// Pure so it is unit-tested; playwright.config.ts feeds it the real os.* numbers.

export interface MachineInfo {
  /** Logical CPU count (os.cpus().length). */
  cpus: number
  /** Physical memory, GB. */
  totalGB: number
  /** Memory available right now, GB (os.freemem — on Windows: available physical). */
  freeGB: number
  /** PW_WORKERS override (CI or a person who knows better). */
  override?: string
}

export interface WorkerPlan {
  workers: number
  /** Per-test timeout, ms — longer when the machine is short on resources. */
  timeout: number
  reason: string
}

/** Cores kept for the Vite dev server, the OS and a running `tauri dev`. */
export const RESERVED_CPUS = 2
/** Memory kept for the OS, Vite and the editor/IDE, GB. */
export const RESERVED_GB = 4
/** Approximate cost of one worker (Chromium + app page), GB. */
export const GB_PER_WORKER = 1.2
export const MAX_WORKERS = 8

export function pickWorkers(m: MachineInfo): WorkerPlan {
  const forced = Number(m.override)
  const byCpu = Math.max(1, Math.floor((m.cpus - RESERVED_CPUS) / 2))
  const byTotal = Math.max(1, Math.floor((m.totalGB - RESERVED_GB) / GB_PER_WORKER))
  const byFree = Math.max(1, Math.floor(m.freeGB / GB_PER_WORKER))
  // Starved machine (little free RAM or few cores): fewer workers AND more time per
  // test, otherwise slow-but-correct tests are reported as failures.
  const starved = m.freeGB < 2 || m.cpus <= 4
  const timeout = starved ? 90_000 : 30_000

  if (Number.isInteger(forced) && forced > 0) {
    return { workers: forced, timeout, reason: `PW_WORKERS=${forced}` }
  }
  const workers = Math.min(byCpu, byTotal, byFree, MAX_WORKERS)
  const limit = workers === byFree ? 'free memory' : workers === byCpu ? 'CPU' : workers === byTotal ? 'total memory' : 'cap'
  return {
    workers,
    timeout,
    reason: `${m.cpus} CPUs, ${m.totalGB.toFixed(1)} GB RAM (${m.freeGB.toFixed(1)} GB free) → ${workers} worker(s), limited by ${limit}`,
  }
}
